const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_Nv3mR6jZnOsFxEs3wbZrvd_Hw3G3bU9x7kabAo23YK62qBAxnFk3KYL',
  wx: createDiagnosticWx(wx),
})

module.exports = { cloud }
