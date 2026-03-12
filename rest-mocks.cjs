/**
 * Built-in REST mock responses (no Microcks dependency needed)
 *
 * Loads OpenAPI and Postman JSON examples from artifacts/
 * and serves them directly from Express.
 */

const fs = require('fs');
const path = require('path');

const ARTIFACTS_DIR = path.resolve(__dirname, 'artifacts');

function loadJsonFile(filename) {
  const filepath = path.join(ARTIFACTS_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

const censusExamples = loadJsonFile('census-api-examples.postman.json');
const statmilkExamples = loadJsonFile('statmilk-examples.postman.json');

function extractPostmanResponses(collection) {
  if (!collection || !collection.item) return {};
  const map = {};
  for (const item of collection.item) {
    if (item.response && item.response.length > 0) {
      const resp = item.response[0];
      try {
        map[item.name] = {
          status: resp.code || 200,
          body: JSON.parse(resp.body || '{}'),
        };
      } catch {
        map[item.name] = { status: resp.code || 200, body: resp.body || '' };
      }
    }
  }
  return map;
}

const censusResponses = extractPostmanResponses(censusExamples);
const statmilkResponses = extractPostmanResponses(statmilkExamples);

function setupRestRoutes(app) {
  // Census REST mock routes
  app.post('/v3/push_notifications', (req, res) => {
    const example = censusResponses['sendPushNotification'] || censusResponses['sendAlert'];
    res.status(example?.status || 201).json(example?.body || {
      id: 12345,
      createdAt: new Date().toISOString(),
      tenant: req.body?.tenant || 'bleacherReport',
      title: req.body?.title || 'Mock notification',
      text: req.body?.text || 'Mock text',
      alertCategories: req.body?.alertCategories || ['news'],
      destinations: req.body?.destinations || [],
      attachments: req.body?.attachments || [],
      tags: [],
    });
  });

  app.get('/v3/:tenant/push_notifications', (req, res) => {
    const example = censusResponses['getAllNotifications'] ||
                    censusResponses['getNotificationsByTenant'];
    if (example?.body) {
      res.json(example.body);
    } else {
      res.json({
        push_notifications: [{
          id: 12345,
          createdAt: new Date().toISOString(),
          tenant: req.params.tenant,
          title: 'Mock: Breaking News',
          text: 'This is mock data from the unified mock server',
          url: 'https://bleacherreport.com/articles/mock',
          spoiler: false,
          showAlertCard: true,
          alertCategories: ['news'],
          allowInRegions: ['US'],
          destinations: [{ id: 1, contentModuleId: 'cm-mock', tagUUID: 'tag-mock' }],
          attachments: [{ id: 1, mediaType: 'jpg', mediaUrl: 'https://media.bleacherreport.com/mock.jpg' }],
          analytics: { genres: ['news'], gamecastType: null },
          tags: [{ uuid: 'tag-mock-uuid' }],
        }],
      });
    }
  });

  app.get('/v3/:tenant/push_notifications/:id', (req, res) => {
    const example = censusResponses['getNotificationById'];
    if (example?.body) {
      res.json(example.body);
    } else {
      res.json({
        id: parseInt(req.params.id),
        createdAt: new Date().toISOString(),
        tenant: req.params.tenant,
        title: 'Mock Notification',
        text: 'Mock notification text',
        url: 'https://bleacherreport.com/articles/mock',
        spoiler: false,
        showAlertCard: true,
        alertCategories: ['news'],
        destinations: [],
        attachments: [],
        analytics: { genres: ['news'], gamecastType: null },
        tags: [],
      });
    }
  });

  app.post('/v3/:tenant/users/:userId/device', (req, res) => {
    res.status(201).json({
      device: {
        id: 42,
        device_id: req.body?.device?.device_token || 'mock-token',
        device_type: req.body?.device?.platform || 'iOS iPhone',
        app_version: req.body?.device?.app_version || '5.0.0',
        os_version: req.body?.device?.os_version || '17.0',
      },
    });
  });

  app.get('/v3/:tenant/tags/:tagUUID/subscriptions/count', (req, res) => {
    res.json({ count: 15420 });
  });

  app.get('/v3/:tenant/tags/:tagUUID/subscriptions', (req, res) => {
    res.json({
      users: [
        { user_id: 'mock-user-001', profile_id: 'mock-profile-001' },
        { user_id: 'mock-user-002', profile_id: 'mock-profile-002' },
      ],
    });
  });

  app.get('/v3/:tenant/user/:userId/tags', (req, res) => {
    res.json({
      subscriptions: [
        { tag_uuid: 'mock-tag-uuid-001' },
        { tag_uuid: 'mock-tag-uuid-002' },
      ],
    });
  });

  app.get('/v3/:tenant/user/:userId/tags/count', (req, res) => {
    res.json({ count: 12 });
  });

  app.post('/v3/alert_buzz/ranks', (req, res) => {
    res.status(202).json({ status: 'accepted' });
  });

  app.get('/v3/:tenant/alert_buzz/ranks/:id', (req, res) => {
    res.json({ rank: 5 });
  });

  app.get('/up/elb', (req, res) => {
    res.json({ status: 'ok' });
  });

  // StatMilk REST mock (if examples loaded)
  app.get('/statmilk/*', (req, res) => {
    const firstKey = Object.keys(statmilkResponses)[0];
    if (firstKey) {
      res.json(statmilkResponses[firstKey].body);
    } else {
      res.json({ data: 'mock-statmilk-response' });
    }
  });

  console.log('  ✓ Built-in REST mocks registered (Census + StatMilk)');
}

module.exports = { setupRestRoutes };
