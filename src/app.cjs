const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));

app.use(require('./routes/health.cjs'));
app.use(require('./routes/graphql.cjs'));
app.use(require('./routes/rest.cjs'));
app.use(require('./routes/ai-generate.cjs'));
app.use(require('./routes/ai-scenario.cjs'));
app.use(require('./routes/ai-setup.cjs'));
app.use(require('./routes/async-api.cjs'));
app.use(require('./routes/schema-api.cjs'));
app.use(require('./routes/dashboard.cjs'));

module.exports = app;
