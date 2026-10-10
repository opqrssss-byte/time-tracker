const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_aEuqo04CtucnCnaaQ8i9oU_KX9epFWbkdZikmsR6fpdEl35UhKMFiAv',
  wx: createDiagnosticWx(wx),
})

module.exports = { cloud }
