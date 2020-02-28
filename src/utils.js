module.exports = {
  parseCookies: response => {
    const list = {}
    const rc = response.headers['set-cookie'][0]

    rc &&
      rc.split(';').forEach(function(cookie) {
        const parts = cookie.split('=')
        list[parts.shift().trim()] = decodeURI(parts.join('='))
      })

    return list
  },
  randomStr: length => {
    var result = ''
    var characters =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    var charactersLength = characters.length
    for (var i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength))
    }
    return result
  }
}
