const responseOverrides = {};
const aiRemovedFields = {};
const scenarioStore = {};

function getUserScope(req) {
  return req.headers['x-user'] || 'global';
}

module.exports = {
  responseOverrides,
  aiRemovedFields,
  scenarioStore,
  getUserScope,
};
