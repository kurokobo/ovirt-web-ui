import React from 'react'
import PropTypes from 'prop-types'
import { connect } from 'react-redux'
import { Wizard } from '@patternfly/react-core'
import produce from 'immer'
import { List } from 'immutable'

import * as Actions from '_/actions'
import { EMPTY_VNIC_PROFILE_ID } from '_/constants'
import { generateUnique, buildMessageFromRecord } from '_/helpers'
import { withMsg } from '_/intl'
import { handleClusterIdChange } from './helpers'
import { createStorageDomainList, createClusterList } from '_/components/utils'

import NavigationConfirmationModal from '../NavigationConfirmationModal'
import BasicSettings from './steps/BasicSettings'
import Networking from './steps/Networking'
import Storage from './steps/Storage'
import SummaryReview from './steps/SummaryReview'
import FinishedStep from './steps/FinishedStep'

const DEFAULT_STATE = {
  activeStepIndex: 0,
  // each time the wizard is opened it should have new key prop
  // this forces component re-creation which clears internal state
  wizardKey: 1,

  steps: {
    basic: {
      name: '',
      operatingSystemId: '0', // "Other OS"
      memory: 1024, // MiB
      cpus: 1,
      startOnCreation: false,
      initEnabled: false,
      optimizedFor: 'desktop',
      topology: {
        sockets: 1,
        cores: 1,
        threads: 1,
      },
      tpmEnabled: undefined,
    },
    network: {
      nics: [],
      updated: 0,
    },
    storage: {
      disks: [],
      updated: 0,
    },
  },

  wizardUpdated: false,
  showCloseWizardDialog: false,
  stepNavigation: {
    basic: {
      valid: false,
      preventEnter: false,
    },
    network: {
      valid: true,
      preventEnter: false,
    },
    storage: {
      valid: false,
      preventEnter: false,
    },
    review: {
      valid: true,
      preventEnter: false,
    },
  },

  // Creation status tracking to drive how the Review screen looks
  correlationId: null,
}

/**
 * Given the set of clusters and VM templates available to the user, build the initial
 * new VM state for the create wizard.
 */
function getInitialState ({
  clusters,
  templates,
  blankTemplateId,
  operatingSystems,
  storageDomains,
  defaultGeneralTimezone,
  defaultWindowsTimezone,
  locale,
}) {
  // 1 cluster available? select it by default
  let changes = {}
  const clustersList = createClusterList({ clusters, locale })
  if (clustersList.length === 1) {
    changes.clusterId = clustersList[0].id
  }

  // 1 template available (Blank only) on the default cluster? set the source to 'iso'
  changes.provisionSource = 'template'
  if (changes.clusterId) {
    changes = {
      ...changes,
      ...handleClusterIdChange(changes.clusterId, {
        blankTemplateId,
        defaultValues: DEFAULT_STATE.steps.basic,
        clusters,
        templates,
        operatingSystems,
        storageDomains,
        defaultGeneralTimezone,
        defaultWindowsTimezone,
        locale,
      }),
    }
  }
  const blankTemplate = templates.get(blankTemplateId)
  let blankTemplateValues = {}

  if (blankTemplate) {
    const osName = (blankTemplate.get('os')).get('type')
    const operatingSystem = operatingSystems.find(os => os.get('name') === osName)
    const operatingSystemId = operatingSystem.get('id')
    const memoryInB = blankTemplate.get('memory')
    const cpus = blankTemplate.getIn(['cpu', 'vCPUs'])
    const initEnabled = blankTemplate.getIn(['cloudInit', 'enabled'])
    const topology = blankTemplate.getIn(['cpu', 'topology']).toJS()

    blankTemplateValues = {
      operatingSystemId,
      memory: memoryInB / (1024 ** 2), // bytes to MiB
      cpus,
      initEnabled,
      topology,
    }
  }

  const state = produce(DEFAULT_STATE, draft => {
    draft.basicDefaultValues = {
      ...DEFAULT_STATE.steps.basic,
      ...blankTemplateValues,
    }

    draft.steps.basic = {
      ...draft.steps.basic,
      ...blankTemplateValues,
      ...changes,
    }
  })

  return state
}

/**
 * Wizard to create a new VM.  Each step in the wizard is a controlled component.  All
 * of the new VM data is held in this component's state until the creation is submitted
 * or the wizard is canceled or closed.
 *
 * Create a new VM from the following sources:
 *   1. ISO (from "scratch")
 *     - Blank Template
 *     - Pick an ISO from the selected Data Center and load as the VM's CD
 *     - Initial boot from CD
 *     - Need to create a disk (unless it is a live CD?, maybe warn on review)
 *     - NIC isn't strictly needed
 *
 *   2. Template
 *     - Pick a template available from the selected Data Center
 *     - Default to __thin__/dependent template use, use __clone__/independent based on
 *       the computer type (desktop == thin, server == clone)
 *         Note: on webadmin, the option is on 'Resource Allocation' advanced options tab
 *         See: https://github.com/oVirt/ovirt-web-ui/issues/882
 *     - Clone permissions? (true if clone is true)
 *     - Boot based on template settings
 *     - Use thin or cloned disks from template (allow adding more and change storage domains)
 *     - NICs default to those from the template (allow adding more)
 */
class CreateVmWizard extends React.Component {
  constructor (props) {
    super(props)

    this.state = getInitialState(props)
    this.hideAndResetState = this.hideAndResetState.bind(this)
    this.hideAndNavigate = this.hideAndNavigate.bind(this)
    this.handleBasicOnUpdate = this.handleBasicOnUpdate.bind(this)
    this.handleBasicOnExit = this.handleBasicOnExit.bind(this)
    this.handleListOnUpdate = this.handleListOnUpdate.bind(this)
    this.handleCreateVm = this.handleCreateVm.bind(this)
    this.hideCloseWizardDialog = this.hideCloseWizardDialog.bind(this)
    this.showCloseWizardDialog = this.showCloseWizardDialog.bind(this)
    this.createSteps = this.createSteps.bind(this)
  }

  createSteps (msg, vmCreateStarted) {
    return [
      {
        id: 'basic',
        name: msg.createVmWizardStepTitleBasic(),

        component: (
          <BasicSettings
            id='create-vm-wizard-basic'
            data={this.state.steps.basic}
            defaultValues={this.state.basicDefaultValues}

            onUpdate={({ valid = false, partialUpdate = {} }) => {
              this.handleBasicOnUpdate(partialUpdate)
              this.setState(produce(draft => {
                draft.stepNavigation.basic.valid = valid
              }))
            }}
          />
        ),
        hideBackButton: true,
        enableNext: this.state.stepNavigation.basic.valid,
        onExit: this.handleBasicOnExit,
        canJumpTo: true,
      },

      {
        id: 'network',
        name: msg.createVmWizardStepTitleNetwork(),

        component: (
          <Networking
            id='create-vm-wizards-net'
            dataCenterId={this.state.steps.basic.dataCenterId}
            clusterId={this.state.steps.basic.clusterId}
            nics={this.state.steps.network.nics}

            onUpdate={({ valid = true, ...updatePayload }) => {
              this.handleListOnUpdate('network', 'nics', updatePayload)
              this.setState(produce(draft => {
                draft.stepNavigation.network.valid = valid
              }))
            }}
          />
        ),
        enableNext: this.state.stepNavigation.network.valid,
        canJumpTo: this.state.stepNavigation.basic.valid,
      },

      {
        id: 'storage',
        name: msg.createVmWizardStepTitleStorage(),

        component: (
          <Storage
            id='create-vm-wizards-storage'
            vmName={this.state.steps.basic.name}
            clusterId={this.state.steps.basic.clusterId}
            dataCenterId={this.state.steps.basic.dataCenterId}
            optimizedFor={this.state.steps.basic.optimizedFor}
            disks={this.state.steps.storage.disks}

            onUpdate={({ valid = true, ...updatePayload }) => {
              this.handleListOnUpdate('storage', 'disks', updatePayload)
              this.setState(produce(draft => {
                draft.stepNavigation.storage.valid = valid
              }))
            }}
          />
        ),
        enableNext: this.state.stepNavigation.storage.valid,
        canJumpTo: this.state.stepNavigation.basic.valid && this.state.stepNavigation.network.valid,
      },
      {
        id: 'review',
        name: msg.createVmWizardStepTitleReview(),

        component: (
          <SummaryReview
            id='create-vm-wizard-review'
            basic={this.state.steps.basic}
            network={this.state.steps.network.nics}
            storage={this.state.steps.storage.disks}
          />
        ),
        onExit: () => this.handleCreateVm(),
        enableNext: true,
        canJumpTo: this.state.stepNavigation.basic.valid && this.state.stepNavigation.network.valid && this.state.stepNavigation.storage.valid,
        nextButtonText: msg.createVmWizardButtonCreate(),

      },
      {
        id: 'finish',
        name: 'Finished',
        component: (() => {
          const { correlationId } = this.state
          const inProgress = correlationId !== null && !this.props.actionResults.has(correlationId)

          const correlatedResult = correlationId === null || inProgress
            ? undefined
            : this.props.actionResults.get(correlationId) ? 'success' : 'error'

          // Look for any `userMessages` that correlate to the last create action executed
          const correlatedMessages = correlationId === null
            ? null
            : this.props.userMessages
              .get('records')
              .filter(
                record => record.getIn(['failedAction', 'meta', 'correlationId']) === correlationId
              )
              .map(record => buildMessageFromRecord(record.toJS(), msg))
              .toJS()

          return (
            <FinishedStep
              hideAndNavigate={this.hideAndNavigate}
              hideAndResetState={this.hideAndResetState}
              progress={{
                inProgress,
                result: correlatedResult, // undefined (no result yet) | 'success' | 'error'
                messages: correlatedMessages,
              }}
            />
          )
        })(),
        isFinishedStep: true,
      },
    ]
  }

  hideCloseWizardDialog () {
    this.setState(produce(draft => { draft.showCloseWizardDialog = false }))
  }

  showCloseWizardDialog () {
    const { wizardUpdated, correlationId } = this.state
    if (wizardUpdated && !correlationId) {
      this.setState(produce(draft => { draft.showCloseWizardDialog = true }))
    } else {
      this.hideAndResetState()
    }
  }

  hideAndResetState () {
    this.setState({
      ...getInitialState(this.props),
      wizardKey: this.state.wizardKey + 1,
    })
    this.props.onHide()
  }

  hideAndNavigate () {
    const vmId = this.props.actionResults.get(this.state.correlationId)
    this.hideAndResetState()
    this.props.navigateToVm(vmId)
  }

  handleBasicOnUpdate (partialUpdate) {
    this.setState(produce(draft => {
      for (const [key, val] of Object.entries(partialUpdate)) {
        draft.steps.basic[key] = val
      }

      draft.wizardUpdated = true

      // reset network and storage updates if the provision source or selected template changes
      const { provisionSource, templateId } = draft.steps.basic
      const { provisionSource: provisionSource_, templateId: templateId_ } = partialUpdate

      if (provisionSource !== provisionSource_ || templateId !== templateId_) {
        draft.steps.network.updated = 0
        draft.steps.storage.updated = 0
      }
    }))
  }

  /**
   * Before transitioning off the Basic page, setup the NICs and Disks as appropriate
   * based on what has been selected/changed.
   */
  handleBasicOnExit () {
    const resetNics = this.state.steps.network.updated === 0
    const resetDisks = this.state.steps.storage.updated === 0

    if (resetNics || resetDisks) {
      this.setState(produce(draft => {
        const template = this.props.templates.get(draft.steps.basic.templateId)

        if (resetNics) {
          draft.steps.network = {
            updated: (draft.steps.network.updated + 1),
            nics: !template
              ? []
              : template.get('nics', List())
                .map(nic => ({
                  id: nic.get('id'),
                  name: nic.get('name'),
                  vnicProfileId: nic.getIn(['vnicProfile', 'id']) || EMPTY_VNIC_PROFILE_ID,
                  deviceType: nic.get('interface'),
                  isFromTemplate: true,
                }))
                .toJS(),
          }
        }

        if (resetDisks) {
          const { storageDomains, locale, msg } = this.props
          const { dataCenterId } = this.state.steps.basic
          const dataCenterStorageDomainsList = createStorageDomainList({
            storageDomains,
            dataCenterId,
            locale,
            msg,
          })

          draft.steps.storage = {
            updated: (draft.steps.storage.updated + 1),
            disks: !template
              ? []
              : template.get('disks', List())
                .map(disk => {
                  const canUserUseStorageDomain =
                    !!dataCenterStorageDomainsList.find(sd => sd.id === disk.get('storageDomainId'))

                  /*
                   * To be consistent with webadmin create VM from a template, diskType needs
                   * to match webadmin's default diskType. Webadmin derives the default disk
                   * type for the template's default storage allocation value, which is derived
                   * from the optimizedFor type.
                   *
                   * Optimized for -> Storage Allocation -> format / diskType:
                   *   - desktop -> Thin -> cow / 'thin'
                   *   - server or high performance -> Clone -> raw / as defined in the template
                   */
                  // TODO: See if the function `determineTemplateDiskFormatAndSparse()` can be used here
                  //       to give exactly matching results to the UI and the API create call
                  const diskType = // constrain to values from createDiskTypeList()
                    template.get('type') === 'desktop' ||
                    this.state.steps.basic.optimizedFor === 'desktop'
                      ? 'thin'
                      : disk.get('sparse') ? 'thin' : 'pre'

                  return {
                    id: disk.get('attachmentId'),
                    name: disk.get('name'),

                    diskId: disk.get('id'),
                    storageDomainId: disk.get('storageDomainId'),
                    canUserUseStorageDomain,

                    bootable: disk.get('bootable'),
                    diskType,
                    size: disk.get('provisionedSize'), // bytes
                    isFromTemplate: true,
                  }
                })
                .map(disk =>
                  // all template disks with invalid storage domain
                  // need to moved to edit mode
                  disk.canUserUseStorageDomain
                    ? disk
                    : {
                      ...disk,
                      underConstruction: {
                        ...disk,
                        storageDomainId: '_',
                      },
                    })
                .toJS(),
          }

          draft.stepNavigation.storage.valid = !draft.steps.storage.disks.find(({ underConstruction }) => underConstruction)
        }
      }))
    }
  }

  handleListOnUpdate (stepName, listName, { remove, update, create } = {}) {
    if (!remove && !update && !create) {
      return
    }

    this.setState(produce(draft => {
      draft.wizardUpdated = true
      const step = draft.steps[stepName]

      if (remove) {
        step[listName] = step[listName].filter(item => item.id !== remove)
      }

      if (update) {
        const toUpdate = step[listName].find(item => item.id === update.id)
        if (toUpdate) {
          for (const [key, val] of Object.entries(update)) {
            toUpdate[key] = val
          }
        }
      }

      if (create) {
        step[listName].push(create)
      }

      step.updated = step.updated + 1
    }))
  }

  handleCreateVm () {
    const correlationId = generateUnique('CreateVmWizard_')
    const { basic, network: { nics }, storage: { disks } } = this.state.steps

    this.setState(produce(draft => { draft.correlationId = correlationId }))
    this.props.onCreate(basic, nics, disks, correlationId)
  }

  render () {
    const { msg, show, actionResults } = this.props
    const { correlationId, showCloseWizardDialog, wizardKey } = this.state
    const vmCreateStarted = correlationId !== null && !!actionResults?.get(correlationId)

    const wizardSteps = this.createSteps(msg, vmCreateStarted)

    const onMove = ({ id: newStepId }, { prevId: oldStepId }) => {
      const oldStep = wizardSteps.find(({ id }) => id === oldStepId)
      oldStep?.onExit?.()
    }

    return (
      <>
        {!showCloseWizardDialog && (
          <Wizard
            key={wizardKey}
            isOpen={show}
            title={msg.addNewVm()}
            onClose={this.showCloseWizardDialog}
            steps={wizardSteps}
            cancelButtonText={msg.createVmWizardButtonCancel()}
            backButtonText={msg.createVmWizardButtonBack()}
            nextButtonText={ msg.createVmWizardButtonNext()}
            onNext={onMove}
            onGoToStep={onMove}
          />
        )
      }
        <NavigationConfirmationModal
          show={showCloseWizardDialog}
          onYes={() => {
            this.setState(produce(draft => { draft.showCloseWizardDialog = false }))
            this.hideAndResetState()
          }}
          onNo={this.hideCloseWizardDialog}
        />
      </>
    )
  }
}

CreateVmWizard.propTypes = {
  show: PropTypes.bool,
  onHide: PropTypes.func,

  // todo remove the "eslint-disable-next-line"s below when updating the eslint to newer version
  // eslint-disable-next-line react/no-unused-prop-types
  clusters: PropTypes.object.isRequired,
  storageDomains: PropTypes.object.isRequired,
  templates: PropTypes.object.isRequired,
  // eslint-disable-next-line react/no-unused-prop-types
  blankTemplateId: PropTypes.string.isRequired,
  userMessages: PropTypes.object.isRequired,
  actionResults: PropTypes.object.isRequired,
  // eslint-disable-next-line react/no-unused-prop-types
  operatingSystems: PropTypes.object.isRequired,

  onCreate: PropTypes.func,
  navigateToVm: PropTypes.func,
  // eslint-disable-next-line react/no-unused-prop-types
  defaultGeneralTimezone: PropTypes.string.isRequired,
  // eslint-disable-next-line react/no-unused-prop-types
  defaultWindowsTimezone: PropTypes.string.isRequired,
  msg: PropTypes.object.isRequired,
  // eslint-disable-next-line react/no-unused-prop-types
  locale: PropTypes.string.isRequired,
}

export default connect(
  (state) => ({
    clusters: state.clusters,
    storageDomains: state.storageDomains,
    templates: state.templates,
    blankTemplateId: state.config.get('blankTemplateId'),
    userMessages: state.userMessages,
    actionResults: state.vms.get('correlationResult'),
    operatingSystems: state.operatingSystems,
    defaultGeneralTimezone: state.config.get('defaultGeneralTimezone'),
    defaultWindowsTimezone: state.config.get('defaultWindowsTimezone'),
  }),
  (dispatch) => ({
    onCreate: (basic, nics, disks, correlationId) => dispatch(
      Actions.composeAndCreateVm({ basic, nics, disks }, { correlationId })
    ),
    navigateToVm: (vmId) => dispatch(Actions.navigateToVmDetails(vmId)),
  })
)(withMsg(CreateVmWizard))
