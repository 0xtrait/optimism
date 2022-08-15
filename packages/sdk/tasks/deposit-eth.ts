import { task, types } from 'hardhat/config'
import '@nomiclabs/hardhat-ethers'
import 'hardhat-deploy'
import { predeploys } from '@eth-optimism/contracts-bedrock'
import { providers, utils } from 'ethers'

import {
  CrossChainMessenger,
  StandardBridgeAdapter,
  MessageStatus,
} from '../src'

task('deposit-eth', 'Deposits WETH9 onto L2.')
  .addParam(
    'l2ProviderUrl',
    'L2 provider URL.',
    'http://localhost:9545',
    types.string
  )
  .addParam(
    'opNodeProviderUrl',
    'op-node provider URL',
    'http://localhost:7545',
    types.string
  )
  .addOptionalParam('to', 'Recipient of the ether', '', types.string)
  .addOptionalParam(
    'amount',
    'Amount of ether to send (in ETH)',
    '',
    types.string
  )
  .addOptionalParam(
    'withdraw',
    'Follow up with a withdrawal',
    true,
    types.boolean
  )
  .addOptionalParam('withdrawAmount', 'Amount to withdraw', '', types.string)
  .setAction(async (args, hre) => {
    const signers = await hre.ethers.getSigners()
    if (signers.length === 0) {
      throw new Error('No configured signers')
    }
    // Use the first configured signer for simplicity
    const signer = signers[0]
    const address = await signer.getAddress()
    console.log(`Using signer ${address}`)

    // Ensure that the signer has a balance before trying to
    // do anything
    const balance = await signer.getBalance()
    if (balance.eq(0)) {
      throw new Error('Signer has no balance')
    }

    const l2Provider = new providers.StaticJsonRpcProvider(args.l2ProviderUrl)

    const Deployment__L2OutputOracleProxy = await hre.deployments.get(
      'L2OutputOracleProxy'
    )

    // send to self if not specified
    const to = args.to ? args.to : address
    const amount = args.amount
      ? utils.parseEther(args.amount)
      : utils.parseEther('1')
    const withdrawAmount = args.withdrawAmount
      ? utils.parseEther(args.withdrawAmount)
      : amount.div(2)

    const l2Signer = new hre.ethers.Wallet(
      hre.network.config.accounts[0],
      l2Provider
    )

    const Artifact__L2ToL1MessagePasser = await hre.deployments.getArtifact(
      'L2ToL1MessagePasser'
    )

    const Artifact__L2CrossDomainMessenger = await hre.deployments.getArtifact(
      'L2CrossDomainMessenger'
    )

    const Artifact__L2StandardBridge = await hre.deployments.getArtifact(
      'L2StandardBridge'
    )

    const Deployment__OptimismPortal = await hre.deployments.get(
      'OptimismPortal'
    )

    const Deployment__OptimismPortalProxy = await hre.deployments.get(
      'OptimismPortalProxy'
    )

    const Deployment__L1StandardBridgeProxy = await hre.deployments.get(
      'L1StandardBridgeProxy'
    )

    const Deployment__L1CrossDomainMessenger = await hre.deployments.get(
      'L1CrossDomainMessenger'
    )

    const Deployment__L1CrossDomainMessengerProxy = await hre.deployments.get(
      'L1CrossDomainMessengerProxy'
    )

    const Deployment__L1StandardBridge = await hre.deployments.get(
      'L1StandardBridge'
    )

    const OptimismPortal = new hre.ethers.Contract(
      Deployment__OptimismPortalProxy.address,
      Deployment__OptimismPortal.abi,
      signer
    )

    const L1CrossDomainMessenger = new hre.ethers.Contract(
      Deployment__L1CrossDomainMessengerProxy.address,
      Deployment__L1CrossDomainMessenger.abi,
      signer
    )

    const L1StandardBridge = new hre.ethers.Contract(
      Deployment__L1StandardBridgeProxy.address,
      Deployment__L1StandardBridge.abi,
      signer
    )

    const L2ToL1MessagePasser = new hre.ethers.Contract(
      predeploys.L2ToL1MessagePasser,
      Artifact__L2ToL1MessagePasser.abi
    )

    const L2CrossDomainMessenger = new hre.ethers.Contract(
      predeploys.L2CrossDomainMessenger,
      Artifact__L2CrossDomainMessenger.abi
    )

    const L2StandardBridge = new hre.ethers.Contract(
      predeploys.L2StandardBridge,
      Artifact__L2StandardBridge.abi
    )

    const messenger = new CrossChainMessenger({
      l1SignerOrProvider: signer,
      l2SignerOrProvider: l2Signer,
      l1ChainId: await signer.getChainId(),
      l2ChainId: await l2Signer.getChainId(),
      bridges: {
        Standard: {
          Adapter: StandardBridgeAdapter,
          l1Bridge: Deployment__L1StandardBridgeProxy.address,
          l2Bridge: predeploys.L2StandardBridge,
        },
      },
      contracts: {
        l1: {
          L1StandardBridge: Deployment__L1StandardBridgeProxy.address,
          L1CrossDomainMessenger:
            Deployment__L1CrossDomainMessengerProxy.address,
          L2OutputOracle: Deployment__L2OutputOracleProxy.address,
          OptimismPortal: Deployment__OptimismPortalProxy.address,
        },
      },
      bedrock: true,
    })

    const opBalanceBefore = await signer.provider.getBalance(
      OptimismPortal.address
    )

    // Deposit ETH
    console.log('Depositing ETH through StandardBridge')
    const ethDeposit = await messenger.depositETH(amount, { recipient: to })
    const depositMessageReceipt = await messenger.waitForMessageReceipt(
      ethDeposit
    )
    if (depositMessageReceipt.receiptStatus !== 1) {
      throw new Error('deposit failed')
    }
    console.log(
      `Deposit complete - ${depositMessageReceipt.transactionReceipt.transactionHash}`
    )

    const opBalanceAfter = await signer.provider.getBalance(
      OptimismPortal.address
    )

    if (!opBalanceBefore.add(amount).eq(opBalanceAfter)) {
      throw new Error(`OptimismPortal balance mismatch`)
    }

    if (!args.withdraw) {
      return
    }

    console.log('Withdrawing ETH')
    const ethWithdraw = await messenger.withdrawETH(withdrawAmount)
    const ethWithdrawReceipt = await ethWithdraw.wait()
    console.log(`ETH withdrawn on L2 - ${ethWithdrawReceipt.transactionHash}`)

    {
      // check the logs
      for (const log of ethWithdrawReceipt.logs) {
        switch (log.address) {
          case L2ToL1MessagePasser.address: {
            const parsed = L2ToL1MessagePasser.interface.parseLog(log)
            console.log(parsed.name)
            console.log(parsed.args)
            console.log()
            break
          }
          case L2StandardBridge.address: {
            const parsed = L2StandardBridge.interface.parseLog(log)
            console.log(parsed.name)
            console.log(parsed.args)
            console.log()
            break
          }
          case L2CrossDomainMessenger.address: {
            const parsed = L2CrossDomainMessenger.interface.parseLog(log)
            console.log(parsed.name)
            console.log(parsed.args)
            console.log()
            break
          }
          default: {
            console.log(`Unknown log from ${log.address} - ${log.topics[0]}`)
          }
        }
      }
    }

    console.log(
      `Withdrawal on L2 complete: ${ethWithdrawReceipt.transactionHash}`
    )

    console.log('Waiting to be able to withdraw')
    setInterval(async () => {
      const currentStatus = await messenger.getMessageStatus(ethWithdrawReceipt)
      console.log(`Message status: ${MessageStatus[currentStatus]}`)
    }, 3000)

    await messenger.waitForMessageStatus(
      ethWithdrawReceipt,
      MessageStatus.READY_FOR_RELAY
    )

    const ethFinalize = await messenger.finalizeMessage(ethWithdrawReceipt)
    const ethFinalizeReceipt = await ethFinalize.wait()
    if (ethFinalizeReceipt.status !== 1) {
      throw new Error('Finalize withdrawal reverted')
    }

    console.log(
      `ETH withdrawal complete: ${ethFinalizeReceipt.transactionHash}`
    )
    {
      // Check that the logs are correct
      for (const log of ethFinalizeReceipt.logs) {
        switch (log.address) {
          case L1StandardBridge.address: {
            const parsed = L1StandardBridge.interface.parseLog(log)
            console.log(parsed.name)
            console.log(parsed.args)
            console.log()
            if (parsed.name !== 'ETHBridgeFinalized') {
              throw new Error('Wrong event name from L1StandardBridge')
            }
            if (!parsed.args.amount.eq(withdrawAmount)) {
              throw new Error('Wrong amount in event')
            }
            if (parsed.args.from !== address) {
              throw new Error('Wrong to in event')
            }
            if (parsed.args.to !== address) {
              throw new Error('Wrong from in event')
            }
            break
          }
          case L1CrossDomainMessenger.address: {
            const parsed = L1CrossDomainMessenger.interface.parseLog(log)
            console.log(parsed.name)
            console.log(parsed.args)
            console.log()
            if (parsed.name !== 'RelayedMessage') {
              throw new Error('Wrong event from L1CrossDomainMessenger')
            }
            break
          }
          case OptimismPortal.address: {
            const parsed = OptimismPortal.interface.parseLog(log)
            console.log(parsed.name)
            console.log(parsed.args)
            console.log()
            // TODO: remove this if check
            if (parsed.name === 'WithdrawalFinalized') {
              if (parsed.args.success !== true) {
                throw new Error('Unsuccessful withdrawal call')
              }
            }
            break
          }
          default: {
            console.log(`Unknown log from ${log.address} - ${log.topics[0]}`)
          }
        }
      }
    }

    const opBalanceFinally = await signer.provider.getBalance(
      OptimismPortal.address
    )

    if (!opBalanceFinally.add(withdrawAmount).eq(opBalanceAfter)) {
      throw new Error('OptimismPortal balance mismatch')
    }
    console.log('Withdraw success')
  })
