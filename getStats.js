

function solInt(buffer) {
  let s = "0x"
  for(let n=7;n>=0;n--) {
    s += buffer.slice(n,n+1).toString("hex")
  }
  const n = parseInt(s)
// don't care!!!
//  if ( n > Number.MAX_SAFE_INTEGER ) {
//    console.log("We might have a problem here",n,"is bigger than",Number.MAX_SAFE_INTEGER)
//  }
  return n
}

async function getStakeHistory(SW3, connection) {

  const buffer = (await connection.getAccountInfo(SW3.SYSVAR_STAKE_HISTORY_PUBKEY)).data

  const EPOCH_HISTORY_RECSIZE = 8 * 4

  const recCount = solInt( buffer.slice(0,8) )

  let stakeHistoryEntries = []

  for (let n=8; n<recCount*EPOCH_HISTORY_RECSIZE; n=n+EPOCH_HISTORY_RECSIZE) {
    const epoch = solInt( buffer.slice(n,n+8) )
    const effectiveStake = solInt( buffer.slice(n+8,n+16) )
    const activatingStake = solInt( buffer.slice(n+16,n+24) )
    const deactivatingStake = solInt( buffer.slice(n+24,n+32) )
    stakeHistoryEntries.push ( { epoch, effectiveStake, activatingStake, deactivatingStake } )
  }

  const getEpoch = function(e) {
    for(let n=0; n<e.length; n++) {
      if( stakeHistoryEntries[n].epoch === e ) {
        return stakeHistoryEntries[n]
      }
    }
    return null
  }

  return { getEpoch }
}

function stakeAndActivating( e, d, sh ) {

  // if the activating epoch for the stake is in the future
  // then no stake will be active, neither
  // will any be activating in this epoch

  if( d.activationEpoch > e ) {
    return [ 0, 0 ]
  }

  // if this is the activating epoch for the stake
  // then no stake is active yet, but all the
  // stake is (potentially) activating

  if( e == d.activationEpoch ) {
    return [ 0, d.stake ]
  }

  let entry = sh.getEpoch( d.activationEpoch )

  // the stake history is limited to 512 entries
  // if the activating epoch is not found in the
  // stake history, assume if was so long ago
  // that all stake is active

  if ( !entry ) {
    return [ d.stake, 0 ]
  }

  // the activation epoch was in the recent past...
  // we will walk forward from the activation epoch
  // to the current epoch to work out how much of
  // the stake has (potentially) been activated
  // by the current epoch


  let effectiveStake = 0
  let nextEpoch = d.activationEpoch


  while( 1 ) {

    // if in this epoch no global stake is activating
    // then all stake must be activated, stop

    if( entry.activatingStake === 0 ) {
      break
    }

    // the stake history contains effective, activating, deactivating totals
    // for the entire system for each epoch

    // only 25% (warmupCooldownRate) of the global stake may be
    // activated or deactived in each epoch

    // calculate activation entitlement

    // remaining unactivated stake as a proportion of global activating stake
    // i.e. stake waiting to activate this epoch

    const weight = (d.stake - effectiveStake) / entry.activating

    // but not all the activating stake may activate
    // only 25% of the currently (active) global stake
    // calc amount of our activating stake that could
    // activate this epoch

    const maxActivatingThisEpoch = Math.max( weight * entry.effectiveStake * d.warmupCooldownRate, 1 )

    effectiveStake += maxActivatingThisEpoch

    // if at this epoch it could all be active, break here

    if ( effectiveStake >= d.stake ) {
      effectiveStake = d.stake
      break
    }

    nextEpoch++

    // if we have reached the current epoch, stop

    if( nextEpoch >= e ) {
      break
    }

    // if we have reached the stake deactivation period, stop

    if( nextEpoch >= d.deactivationEpoch ) {
      break
    }

    const nextEntry = sh.getEpoch(nextEpoch)

    // this should not happen

    if ( !nextEntry ) {
      break
    }

    entry = nextEntry
  }

  return [ effectiveStake, d.stake - effectiveStake ]
}

function calcActiveStake( e, d, sh ) {

  // 1. first calculate active stake and activating stake

  const [ stake, activating ] = stakeAndActivating( e, d, sh )

  // 2. then adjust for deactivation, if required

  // if the deactiving epoch is in the future, then
  // there is no deactivating stake, and the active
  // stake we calculated is correct

  if( d.deactivationEpoch > e ) {
    return stake
  }

  // if the deactiving epoch is current epoch, then
  // there is deactivating stake, but has not effected
  // active stake yet

  if( d.deactivationEpoch == e ) {
    return stake
  }

  let entry = sh.getEpoch( d.activationEpoch )

  // the stake history is limited to 512 entries
  // if the deactivating epoch is not found in the
  // stake history, assume if was so long ago
  // that all stake is deactivated

  if ( !entry ) {
    return 0
  }

  let effectiveStake = stake
  let nextEpoch = d.deactivationEpoch

  // we will now walk forward from the deactivation epoch
  // calculating deactivating stake and adjusting the
  // numbers we calculated previously, when we did this
  // same thing but only considering stake activation

  while(1) {

    // if there is no deactivating stake in this epoch
    // the all stake has been deactived

    if( entry.deactivatingStake = 0 ) {
      break
    }

    // ratio of stake left to deactivate vs global deactivating stake this epoch

    const weight = effectiveStake / entry.deactivatingStake

    // but not all the dectivating stake may deactivate
    // only 25% of the currently (active) global stake
    // calc amount of our deactivating stake that could
    // deactivate this epoch

    const maxDeactivatingThisEpoch = Math.max( weight * entry.effectiveStake * d.warmupCooldownRate, 1 )

    effectiveStake -= maxDeactivatingThisEpoch

    if( effectiveStake <= 0 ) {
      effectiveStake = 0
      break
    }

    nextEpoch++

    // if we have reached the current epoch, stop

    if( nextEpoch >= e ) {
      break
    }

    const nextEntry = sh.getEpoch(nextEpoch)

    // this should not happen

    if ( !nextEntry ) {
      break
    }

    entry = nextEntry
  }

  return effectiveStake
}

async function validatorStaked(SW3, connection) {

  const voteAccounts = await connection.getVoteAccounts( 'singleGossip' )

  const validatorStake1 = voteAccounts.current.concat( voteAccounts.delinquent )
                          .filter( v => v.activatedStake )
                          .map( v => ( { entryPubkey: v.nodePubkey, allocation: parseInt( v.activatedStake, 10 ) } ) )

  // seems like some nodes have more than one vote account

  let dedup={}
  for(let n=0; n<validatorStake1.length; n++) {
    if( dedup[validatorStake1[n].entryPubkey] ) {
      dedup[validatorStake1[n].entryPubkey] += validatorStake1[n].allocation
    } else {
      dedup[validatorStake1[n].entryPubkey] = validatorStake1[n].allocation 
    } 
  }

  let validatorStake2 = []
  for (const [entryPubkey, allocation] of Object.entries(dedup)) {
    validatorStake2.push( { entryPubkey, allocation } )
  }

  const validatorStake3 = validatorStake2.sort( (a,b) => b.allocation-a.allocation )

  const totalStake = validatorStake3.reduce( (h,{allocation}) => h + allocation, 0 )

  const epoch = (await connection.getEpochInfo( 'singleGossip' )).epoch

  return {
    epoch,
    totalStake,
    validatorStake: validatorStake3,
  }
}

function delegatedStakeAccountsOnly( all ) {

  let delegated = []

  for( n=0; n<all.length; n++ ) {
    const a = all[n]
    const stakePubkey = a.pubkey.toString()
    const authPubkey = a.account?.data?.parsed?.info?.meta?.authorized?.staker
    const delegationStrings = a.account?.data?.parsed?.info?.stake?.delegation

    if ( authPubkey && delegationStrings && delegationStrings.stake ) {

      // the RPC call returns strings for some number fields, force js to treat as numbers
      const delegation = {
        activationEpoch:    Number(delegationStrings.activationEpoch), 
        deactivationEpoch:  Number(delegationStrings.deactivationEpoch),
        stake:              Number(delegationStrings.stake),
        entry:              delegationStrings.entry,
        warmupCooldownRate: delegationStrings.warmupCooldownRate,
      }

      delegated.push( { stakePubkey, authPubkey, delegation } ) 
    }
  }

  return delegated
}



async function getStats(SW3,url,gather) {

  let data = {}  

  const connection = new SW3.Connection(url, 'recent')

  if ( gather === 'ValidatorStaked' ) {
    const vs = await validatorStaked(SW3, connection) 
    if ( vs.error ) {
      data.error = vs.error 
      data.status = vs.status
    } else {
      data.epoch = vs.epoch
      data.status = 'Epoch '+data.epoch+' - Validator Node PubKeys, Total Delegated Active Stake'
      data.totalLamports = vs.totalStake
      data.totalSol = vs.totalStake / SW3.LAMPORTS_PER_SOL 
      data.entries = vs.validatorStake
    }
    return data
  }

  if ( gather === 'AuthorizedStaker' ) {
    const as = await authorizedStaker(SW3, connection) 
    if ( as.error ) {
      data.error = as.error 
      data.status = as.status
    } else {
      data.epoch = as.epoch
    data.status = 'Epoch '+data.epoch+' - Authorized Staker PubKeys, Total Delegated Active Stake'
      data.totalLamports = as.totalStake
      data.totalSol = as.totalStake / SW3.LAMPORTS_PER_SOL 
      data.entries = as.authStake
    }
    return data
  }
  

  data.status = "Error - Unexpected option"
  data.error = 1
  return data
}


async function getAllStakeAccounts(SW3, connection) {
  const spPK = new SW3.PublicKey('Stake11111111111111111111111111111111111111')
  return await connection.getParsedProgramAccounts( spPK, 'singleGossip' )
}

async function authorizedStaker(SW3, connection) {

  // Get all stake accounts in the system

  const allStakeAccounts = await getAllStakeAccounts( SW3, connection )

  // only interested in those that are delegated

  const delegatedStakeAccounts = delegatedStakeAccountsOnly( allStakeAccounts )

  // need to calculate current active stake for each account

  const epoch = (await connection.getEpochInfo( 'singleGossip' )).epoch

  const stakeHistory = await getStakeHistory(SW3, connection)

  stakeAccountsActive = []

  for( let n=0; n<delegatedStakeAccounts.length; n++ ){

    const a = delegatedStakeAccounts[n]

    const activeStake = calcActiveStake( epoch, a.delegation, stakeHistory )

    if( activeStake ) {
      stakeAccountsActive.push( { stakePubkey: a.stakePubkey, authPubkey: a.authPubkey, active: activeStake } )
    }
  }

  // an authorized staker could have many accounts, so sum up on authPubkey

  let authTotals = {}

  for( let n=0; n<stakeAccountsActive.length; n++ ) {
    const a = stakeAccountsActive[n]
    if ( authTotals[a.authPubkey] ) {
      authTotals[a.authPubkey] += a.active
    } else {
      authTotals[a.authPubkey] = a.active
    }
  }

  let authStake1 = []
  for (const [entryPubkey, allocation] of Object.entries(authTotals)) {
    authStake1.push( { entryPubkey, allocation } )
  }

  const authStake2 = authStake1.sort( (a,b) => b.allocation-a.allocation )

  const totalStake = authStake2.reduce( (h,{allocation}) => h + allocation, 0 )
 
  return {
    epoch,
    totalStake,
    authStake: authStake2, 
  }
}
