const {
  BaseKonnector,
  requestFactory,
  log,
  saveBills
} = require('cozy-konnector-libs')
require('moment')
require('pdfjs')
require('fs')

const { parseCookies, randomStr } = require('./utils')

const { randomBytes } = require('crypto')
const { encode: base64url } = require('base64url')
const random = (bytes = 32) => base64url(randomBytes(bytes))

const TOKEN_REGEX = /#access_token=([0-9aA-zZ\-_]+)&/
const TRIM_REGEX = /([0-9]).*([0-9]{4})/

const VENDOR = 'URSAFF'

const request = requestFactory({
  debug: false,
  cheerio: false,
  json: true,
  jar: true
})

const requestHtml = requestFactory({
  debug: true,
  cheerio: true,
  json: false,
  jar: true
})

module.exports = new BaseKonnector(start)

const CONFIG_URL =
  'https://www.autoentrepreneur.urssaf.fr/services/assets/config/config.js'
const CONTEXT_URL =
  'https://api.urssaf.fr/micro_entrepreneur/v2/profil/profil/contexte'

let cookies = {}

async function start(fields) {
  log('info', 'Fetching config...')
  const config = await fetchConfig()
  const params = getParams(config)

  log('info', 'Authenticating...')
  const token = await login(config.ARCHIMED_CLIENT_ID, params, { ...fields })
  log('info', 'Successfully logged in')

  log('info', 'Fetching context...')
  const context = await fetchContext(token)

  log('info', 'Fetching bills...')
  const bills = await fetchBills(token, context)

  log('info', 'Saving data to Cozy')
  await saveBills(bills, fields, {
    identifiers: ['PRLV DIRECTION GENERALE DES FINANCES PUBLIQUES']
  })
}

/**
 * Fetch API configuration
 */
async function fetchConfig() {
  log('info', 'Fetch config')
  const result = await request(CONFIG_URL)
  const config = result.replace('window.token =', '').replace('};', '}')
  return JSON.parse(config)
}

/**
 * Fetch OAuth params
 */
function getParams(config) {
  return {
    scope: config.ARCHIMED_SCOPE,
    response_type: 'id_token token',
    redirect_uri:
      'https://www.autoentrepreneur.urssaf.fr/services/callback?action=login',
    state: randomStr(56),
    nonce: random(),
    client_id: config.ARCHIMED_CLIENT_ID
  }
}

/**
 * Login via Net-Entreprise
 */
async function login(clientId, params, fields) {
  const urlOk = `https://login.urssaf.fr/api/neten/v1/gip-mds/${clientId}?redirect_uri=https%3A%2F%2Fwww.autoentrepreneur.urssaf.fr%2Fservices%2Fcallback%3Faction%3Dlogin&nonce=${
    params.nonce
  }&state=${params.state}`
  const urlKo = `https://login.urssaf.fr/api/neten/v1/callback/${clientId}?redirect_uri=https%3A%2F%2Fwww.autoentrepreneur.urssaf.fr%2Fservices%2Fcallback%3Faction%3Dlogin`

  const response = await request({
    method: 'POST',
    headers: {
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    },
    uri: 'https://portail.net-entreprises.fr/auth/MAG/widget/validation',
    resolveWithFullResponse: true,
    form: {
      urlOK: urlOk,
      urlKO: urlKo,
      nomJeton: 'jtd',
      siret: fields.siret,
      nom: fields.lastname,
      prenom: fields.firstname,
      password: fields.password
    }
  })

  // Extracts JTD cookie
  cookies = parseCookies(response)
  const jtd = decodeURIComponent(cookies['JTD'])

  const res = await requestHtml({
    method: 'POST',
    uri: urlOk,
    form: {
      jtd: jtd
    },
    resolveWithFullResponse: true,
    followRedirect: false
  })

  // Extract the Bearer token
  const hash = res.request.uri.hash
  return TOKEN_REGEX.exec(hash)[1]
}

/**
 * Fetches account context
 */
async function fetchContext(token) {
  const resp = await request({
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Referer:
        'https://www.autoentrepreneur.urssaf.fr/services/espace-personnel/mes-documents/mes-declarations',
      Origin: 'https://www.autoentrepreneur.urssaf.fr',
      DNT: 1
    },
    body: {},
    uri: CONTEXT_URL
  })

  const context = resp.contexte

  // There's no letter in the API requests... so we remove it
  context.codeUr = /([0-9]+)/.exec(context.coti.orga)[1]

  return context
}

/**
 * Fetches bills
 */
async function fetchBills(token, context) {
  const bills = await request({
    url: 'https://api.urssaf.fr/beae/declaration/v1/declarations',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    qs: {
      idCotisant: context.idabo,
      codeUr: context.codeUr,
      numCptExt: context.coti.numcot,
      sort: 'codePeriode,desc'
    }
  })

  log('info', `${bills.length} bills available`)

  const list = []
  for (const bill of bills) {
    const single = await fechSingleBill(bill, token, context)
    if (single) {
      list.push(single)
    }
  }

  return list
}

/**
 * Fetches a single bill from its metadata
 */
async function fechSingleBill(metadata, token, context) {
  // Retrives bill data
  const resp = await request({
    url: `https://api.urssaf.fr/beae/declaration/v1/declarations/${
      metadata.codePeriode
    }?codeUr=${context.codeUr}&numCptExt=${context.coti.numcot}&idCotisant=${
      context.idabo
    }`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  })

  const data = resp.data

  // Computes amount
  const mntBank = data.declaration.mts.mtdec
  const mntPapier =
    data.declaration.origine.api === 'PAPIER'
      ? data.declaration.mts.mtapa
      : null

  let mnt = null

  if (mntBank !== null) {
    mnt = mntBank
  } else if (mntPapier !== null) {
    mnt = mntPapier
  }

  // Map data ito a Cozy bill
  if (mnt !== null) {
    const trimestre = TRIM_REGEX.exec(metadata.libellePeriode)

    return {
      title: `${trimestre[1]} trimestre ${trimestre[2]}`,
      fileurl: data.declaration_pdf, // FIXME : For old paper declarations, PDF is not available....
      amount: +mnt,
      date: new Date(data.declaration.dh_dec_date),
      currency: 'EUR',
      filename: `${trimestre[1]}-trimestre-${trimestre[2]}.pdf`,
      vendor: VENDOR,
      metadata: {
        importDate: new Date(),
        version: 1
      }
    }
  }

  return null
}
