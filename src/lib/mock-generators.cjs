const crypto = require('crypto');
const { faker } = require('@faker-js/faker');
const { SCALAR_TYPES } = require('./graphql-utils.cjs');

// Sports-specific mock data generators
function generateSportsTeamName() {
  const teams = [
    'Lakers', 'Warriors', 'Celtics', 'Heat', 'Grizzlies', 'Suns',
    'Cowboys', 'Patriots', 'Chiefs', 'Eagles', 'Packers', '49ers',
    'Yankees', 'RedSox', 'Dodgers', 'Giants', 'Cubs', 'Cardinals',
    'Lightning', 'Maple Leafs', 'Rangers', 'Penguins', 'Avalanche', 'Hurricanes'
  ];
  return teams[Math.floor(Math.random() * teams.length)];
}

function generateSportsLeague() {
  const leagues = ['NBA', 'NFL', 'MLB', 'NHL', 'MLS', 'NCAAF', 'NCAAB', 'EPL', 'La Liga', 'Serie A'];
  return leagues[Math.floor(Math.random() * leagues.length)];
}

function generateStadiumName() {
  const stadiums = [
    'Staples Center', 'TD Garden', 'Madison Square Garden', 'FedEx Forum',
    'MetLife Stadium', 'Arrowhead Stadium', 'AT&T Stadium', 'Lambeau Field',
    'Yankee Stadium', 'Fenway Park', 'Dodger Stadium', 'Wrigley Field'
  ];
  return stadiums[Math.floor(Math.random() * stadiums.length)];
}

function generateGameStatus() {
  const statuses = ['scheduled', 'in-progress', 'finished', 'postponed', 'cancelled', 'live'];
  return statuses[Math.floor(Math.random() * statuses.length)];
}

function generateMockValue(fieldName, typeInfo, types, enums, depth = 0) {
  const tname = typeInfo.name;

  if (enums[tname]) {
    const vals = enums[tname];
    return vals[Math.floor(Math.random() * vals.length)];
  }

  if (SCALAR_TYPES.has(tname) || depth > 3) {
    const fn = fieldName.toLowerCase();
    if (tname === 'ID') {
      return crypto.randomUUID();
    }
    if (tname === 'Int') {
      if (fn.includes('score')) return faker.number.int({ min: 0, max: 150 });
      if (fn.includes('count')) return faker.number.int({ min: 0, max: 500 });
      if (fn.includes('position') || fn.includes('rank')) return faker.number.int({ min: 1, max: 50 });
      if (fn.includes('wins') || fn.includes('losses') || fn.includes('draws')) return faker.number.int({ min: 0, max: 82 });
      if (fn.includes('balls')) return faker.number.int({ min: 0, max: 3 });
      if (fn.includes('strikes')) return faker.number.int({ min: 0, max: 2 });
      if (fn.includes('outs')) return faker.number.int({ min: 0, max: 2 });
      return faker.number.int({ min: 0, max: 1000 });
    }
    if (tname === 'Float' || tname === 'BigDecimal') {
      if (fn.includes('average')) return +(Math.random() * 0.4).toFixed(3);
      return +(Math.random() * 100).toFixed(2);
    }
    if (tname === 'Boolean') {
      if (fn.includes('hidden') || fn.includes('locked') || fn.includes('pinned')) return false;
      if (fn.includes('enabled') || fn.includes('published') || fn.includes('current')) return true;
      return Math.random() > 0.5;
    }
    if (tname === 'Date' || tname === 'DateTime') {
      return faker.date.recent().toISOString();
    }
    // String or other scalar — sports-aware value generation
    if (fn.includes('date') || fn.includes('createdat') || fn.includes('updatedat') || fn.includes('startat') || fn.includes('endat') || fn.includes('startdate') || fn.includes('enddate') || fn.includes('gamedate') || fn.includes('gameenddate')) return faker.date.recent().toISOString().slice(0, -5) + 'Z';
    if (fn.includes('slug')) return ['nfl-patriots-vs-chiefs', 'nba-lakers-vs-celtics', 'mlb-yankees-vs-dodgers', 'nfl-eagles-vs-cowboys', 'nba-warriors-vs-suns'][Math.floor(Math.random() * 5)];
    if (fn.includes('uuid') || fn.includes('taguuid')) return crypto.randomUUID();
    if (fn.includes('hash')) return crypto.randomUUID().replace(/-/g, '');
    if (fn.includes('email')) return faker.internet.email();
    if (fn.includes('url') || fn.includes('link') || fn.includes('thumbnail') || fn.includes('permalink')) return 'https://sports.example.com/' + faker.lorem.slug();
    if (fn.includes('logo') || fn.includes('image') || fn.includes('avatar')) return 'https://sports.example.com/logos/' + faker.lorem.slug() + '.png';
    if (fn === 'name' || fn === 'shortname') return generateSportsTeamName();
    if (fn.includes('title') || fn.includes('headline')) return ['NFL Week 12', 'NBA Playoffs Round 1', 'MLB World Series Game 5', 'Premier League Matchday 15'][Math.floor(Math.random() * 4)];
    if (fn.includes('subname')) return ['Game 1 of 7', 'Conference Finals', 'Divisional Round', 'Wild Card'][Math.floor(Math.random() * 4)];
    if (fn.includes('description') || fn.includes('commentary') || fn.includes('about')) return faker.lorem.sentence();
    if (fn.includes('team') || fn === 'hometeam' || fn === 'awayteam') return generateSportsTeamName();
    if (fn.includes('player') || fn === 'batter' || fn === 'pitcher') return faker.person.fullName();
    if (fn.includes('league')) return generateSportsLeague();
    if (fn.includes('stadium')) return generateStadiumName();
    if (fn.includes('location') || fn.includes('city')) return faker.location.city();
    if (fn.includes('state')) return faker.location.state();
    if (fn.includes('country')) return faker.location.country();
    if (fn.includes('zip')) return faker.location.zipCode();
    if (fn.includes('venue')) return generateStadiumName();
    if (fn.includes('abbrev')) return ['LAL', 'GSW', 'BOS', 'MIA', 'MEM', 'PHX', 'DAL', 'DEN', 'CHI', 'NYK'][Math.floor(Math.random() * 10)];
    if (fn.includes('color')) return faker.color.rgb();
    if (fn.includes('record')) return `${faker.number.int({min:0,max:82})}-${faker.number.int({min:0,max:82})}`;
    if (fn.includes('score') || fn.includes('mainscore') || fn.includes('secondaryscore') || fn.includes('subscore')) return String(faker.number.int({ min: 0, max: 45 }));
    if (fn.includes('market')) return faker.location.city();
    if (fn.includes('mascot')) return faker.word.adjective() + ' ' + faker.word.noun();
    if (fn.includes('status')) return generateGameStatus();
    if (fn.includes('sport')) return ['Football', 'Basketball', 'Baseball', 'Hockey', 'Soccer'][Math.floor(Math.random() * 5)];
    if (fn.includes('network')) return ['ESPN', 'CBS', 'FOX', 'NBC', 'TNT', 'ABC'][Math.floor(Math.random() * 6)];
    if (fn.includes('playperiodcondensed')) return ['1st', '2nd', '3rd', '4th', 'OT', 'Half'][Math.floor(Math.random() * 6)];
    if (fn.includes('playperiod')) return ['1st Quarter', '2nd Quarter', '3rd Quarter', '4th Quarter', 'Halftime', 'Overtime'][Math.floor(Math.random() * 6)];
    if (fn.includes('clock')) return `${faker.number.int({min:0,max:15})}:${String(faker.number.int({min:0,max:59})).padStart(2,'0')}`;
    if (fn.includes('inningphase')) return ['Top', 'Bottom', 'Mid'][Math.floor(Math.random() * 3)];
    if (fn.includes('round')) return ['Round 1', 'Round 2', 'Quarterfinals', 'Semifinals', 'Finals'][Math.floor(Math.random() * 5)];
    if (fn.includes('weather')) return ['Sunny', 'Cloudy', 'Rainy', 'Clear', 'Partly Cloudy', 'Windy'][Math.floor(Math.random() * 6)];
    if (fn.includes('weatheremoji')) return ['☀️', '🌤', '🌧', '🌬', '❄️', '⛅'][Math.floor(Math.random() * 6)];
    if (fn.includes('distance')) return String(faker.number.int({min:100, max:5000}));
    if (fn.includes('distanceunit')) return ['meters', 'miles', 'km', 'yards'][Math.floor(Math.random() * 4)];
    if (fn.includes('laps')) return String(faker.number.int({min:1, max:200}));
    if (fn.includes('type')) return ['Regular', 'Playoff', 'Championship', 'Exhibition'][Math.floor(Math.random() * 4)];
    if (fn.includes('place') || fn.includes('result') || fn.includes('subresult')) return String(faker.number.int({min:1, max:20}));
    if (fn.includes('odds')) return ['-3.5', '+7', '-110', '+150', 'EVEN'][Math.floor(Math.random() * 5)];
    if (fn.includes('site')) return ['Home', 'Away', 'Neutral'][Math.floor(Math.random() * 3)];
    if (fn.includes('text') || fn.includes('value')) return faker.lorem.words(3);
    if (fn.includes('language')) return ['en', 'es', 'pt', 'fr'][Math.floor(Math.random() * 4)];
    if (fn.includes('number')) return String(faker.number.int({min:1, max:99}));
    if (fn.includes('jsonresponse')) return JSON.stringify({ key: 'value' });
    if (fn.includes('mediatype')) return ['image/jpeg', 'image/png', 'video/mp4'][Math.floor(Math.random() * 3)];
    if (fn.includes('mediaurl')) return 'https://media.example.com/' + faker.lorem.slug() + '.jpg';
    if (fn === 'cursor' || fn === 'after' || fn === 'before') return Buffer.from('cursor:' + Math.floor(Math.random() * 100)).toString('base64');
    if (fn.includes('id') || fn.includes('foreignid') || fn.includes('cmsid') || fn.includes('editid')) return 'id-' + faker.string.alphanumeric(8);
    if (fn.includes('code')) return faker.string.alphanumeric(6).toUpperCase();
    return faker.lorem.words(2);
  }

  if (types[tname]) {
    return generateMockObject(tname, types, enums, depth + 1);
  }

  return null;
}

function generateMockObject(typeName, types, enums, depth = 0) {
  if (depth > 3 || !types[typeName]) return null;
  const fields = types[typeName];
  const obj = {};
  for (const [fname, typeInfo] of Object.entries(fields)) {
    if (typeInfo.isList) {
      const count = depth > 1 ? 1 : Math.floor(Math.random() * 2) + 1;
      obj[fname] = [];
      for (let i = 0; i < count; i++) {
        obj[fname].push(generateMockValue(fname, { ...typeInfo, isList: false }, types, enums, depth));
      }
    } else {
      obj[fname] = generateMockValue(fname, typeInfo, types, enums, depth);
    }
  }
  return obj;
}

function resolveSchemaRef(ref, spec) {
  if (!ref || !ref.startsWith('#/')) return {};
  const parts = ref.replace('#/', '').split('/');
  let result = spec;
  for (const p of parts) { result = result?.[p]; }
  return result || {};
}

function generateMockFromOpenAPISchema(schema, spec, depth = 0) {
  if (depth > 3) return null;
  if (schema.$ref) schema = resolveSchemaRef(schema.$ref, spec);

  if (schema.type === 'object' || schema.properties) {
    const obj = {};
    const required = schema.required || [];
    for (const [key, prop] of Object.entries(schema.properties || {})) {
      const resolved = prop.$ref ? resolveSchemaRef(prop.$ref, spec) : prop;
      const fn = key.toLowerCase();
      const isRequired = required.includes(key);

      if (resolved.type === 'string') {
        if (resolved.format === 'uuid' || fn === 'id' || fn.endsWith('id'))
          obj[key] = crypto.randomUUID();
        else if (resolved.format === 'date-time' || fn.includes('date') || fn.includes('time'))
          obj[key] = faker.date.recent().toISOString();
        else if (resolved.format === 'date')
          obj[key] = faker.date.recent().toISOString().split('T')[0];
        else if (fn.includes('email')) 
          obj[key] = faker.internet.email();
        else if (fn.includes('phone'))
          obj[key] = faker.phone.number();
        else if (fn.includes('url') || fn.includes('link'))
          obj[key] = faker.internet.url();
        else if (fn.includes('name') || fn.includes('title'))
          obj[key] = faker.person.fullName();
        else if (fn.includes('description') || fn.includes('bio'))
          obj[key] = faker.lorem.sentence();
        else if (fn.includes('address'))
          obj[key] = faker.location.streetAddress();
        else if (fn.includes('city'))
          obj[key] = faker.location.city();
        else if (fn.includes('country'))
          obj[key] = faker.location.country();
        else if (fn.includes('street'))
          obj[key] = faker.location.street();
        else if (fn.includes('zipcode') || fn.includes('postal'))
          obj[key] = faker.location.zipCode();
        else if (fn.includes('slug'))
          obj[key] = faker.helpers.slugify(faker.lorem.word()).toLowerCase();
        else if (fn.includes('username'))
          obj[key] = faker.internet.username();
        else if (fn.includes('password'))
          obj[key] = faker.internet.password({ length: 16, memorable: false });
        else if (fn.includes('avatar') || fn.includes('image'))
          obj[key] = faker.image.avatar();
        // Sports-specific fields
        else if (fn.includes('team') && !fn.includes('id'))
          obj[key] = generateSportsTeamName();
        else if (fn.includes('league') || fn.includes('sport'))
          obj[key] = generateSportsLeague();
        else if (fn.includes('stadium') || fn.includes('venue'))
          obj[key] = generateStadiumName();
        else if (fn.includes('status'))
          obj[key] = generateGameStatus();
        else if (fn.includes('abbreviation') || fn.includes('abbrev'))
          obj[key] = faker.string.alphanumeric(3).toUpperCase();
        else if (resolved.enum) 
          obj[key] = resolved.enum[Math.floor(Math.random() * resolved.enum.length)];
        else 
          obj[key] = faker.lorem.word();
      } else if (resolved.type === 'integer') {
        if (fn.includes('age'))
          obj[key] = faker.number.int({ min: 18, max: 80 });
        else if (fn.includes('port'))
          obj[key] = faker.number.int({ min: 1000, max: 65535 });
        else if (fn.includes('count') || fn.includes('total'))
          obj[key] = faker.number.int({ min: 0, max: 1000 });
        else if (fn.includes('score'))
          obj[key] = faker.number.int({ min: 0, max: 150 });
        else if (fn.includes('rating') || fn.includes('rank'))
          obj[key] = faker.number.int({ min: 1, max: 100 });
        else
          obj[key] = faker.number.int({ min: 0, max: 10000 });
      } else if (resolved.type === 'number') {
        if (fn.includes('price') || fn.includes('cost') || fn.includes('amount'))
          obj[key] = faker.commerce.price();
        else if (fn.includes('latitude'))
          obj[key] = faker.location.latitude();
        else if (fn.includes('longitude'))
          obj[key] = faker.location.longitude();
        else
          obj[key] = +(Math.random() * 100).toFixed(2);
      } else if (resolved.type === 'boolean') {
        obj[key] = Math.random() > 0.5;
      } else if (resolved.type === 'array') {
        obj[key] = [generateMockFromOpenAPISchema(resolved.items || {}, spec, depth + 1)];
      } else if (resolved.type === 'object' || resolved.properties) {
        const nestedObj = generateMockFromOpenAPISchema(resolved, spec, depth + 1);
        // For optional fields, if object is empty or null, use null instead of {}
        if (!isRequired && (!nestedObj || Object.keys(nestedObj).length === 0)) {
          obj[key] = null;
        } else {
          obj[key] = nestedObj;
        }
      } else if (!isRequired) {
        // For any other optional field that doesn't have a specific generator, use null
        obj[key] = null;
      }
    }
    return obj;
  }

  if (schema.type === 'array' && schema.items) {
    return [generateMockFromOpenAPISchema(schema.items, spec, depth + 1),
            generateMockFromOpenAPISchema(schema.items, spec, depth + 1)];
  }

  if (schema.type === 'string') return faker.lorem.word();
  if (schema.type === 'integer') return faker.number.int({ min: 0, max: 100 });
  if (schema.type === 'number') return +(Math.random() * 100).toFixed(2);
  if (schema.type === 'boolean') return true;
  return null;
}

module.exports = {
  generateMockValue,
  generateMockObject,
  generateSportsTeamName,
  generateSportsLeague,
  generateStadiumName,
  generateGameStatus,
  generateMockFromOpenAPISchema,
};
