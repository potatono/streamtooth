// Core imports
const fs = require('fs');
const path = require('path');
const { get } = require('http');

// Express imports
const express = require('express');
const handlebars = require('handlebars');

// ATProto imports
const { NodeOAuthClient } = require('@atproto/oauth-client-node');
const { JoseKey } = require('@atproto/jwk-jose');
const { Agent } = require('@atproto/api');

// Firebase imports
const functions = require('firebase-functions/v1');
const { initializeApp, applicationDefault, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp, FieldValue, Filter } = require('firebase-admin/firestore');

// TODO FIXME Make configurable
const host = 'dev.s2th.tv';
const defaultChannel = 'potate_oh_no'

// Express setup
const app = express();
const playTemplate = handlebars.compile(fs.readFileSync(path.join(__dirname, 'views', 'play.hbs'), 'utf8'));
const homeHemplate = handlebars.compile(fs.readFileSync(path.join(__dirname, 'views', 'home.hbs'), 'utf8'));

// Initialize firebase from credential (since we want to support function and standalone)
console.log("Trying to initialize firebase with credentials..");
var credential = require('./serviceAccountKey.json');
initializeApp({ credential: cert(credential) });
const db = getFirestore();
//db.settings({ ignoreUndefinedProperties: true })
const auth = getAuth();

// Initialize ATProto OAuth client
const clientMetadata = {
    // Must be a URL that will be exposing this metadata
    client_id: `https://${host}/client-metadata.json`,
    client_name: 'StreamTooth',
    client_uri: `https://${host}`,
    logo_uri: `https://${host}/s/logo.png`,
    tos_uri: `https://${host}/s/tos`,
    policy_uri: `https://${host}/s/policy`,
    redirect_uris: [`https://${host}/callback`],
    scope: 'atproto transition:generic',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'web',
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'RS256',
    dpop_bound_access_tokens: true,
    jwks_uri: `https://${host}/jwks.json`,
};

function getKeySet() {
  var jwtPrivateKeys = require('./jwtPrivateKey.json').jwtPrivateKeys;
  jwtPrivateKeys = [ jwtPrivateKeys[0] ];
  return Promise.all(
    jwtPrivateKeys.map((key) => { 
      key = key.join("\n");
      console.log(key);
      return JoseKey.fromImportable(key, kid = '1'); 
    })
  );
}

function getStore(collection) {
  return {
    async set(key, internalState) { 
      var state = JSON.stringify(internalState);
      await db.collection(collection).doc(key).set({ state });
    },
    async get(key) { 
      var doc = await db.collection(collection).doc(key).get();
      var state = doc.data();
      return JSON.parse(state.state);
    },
    async del(key) { 
      await db.collection(collection).doc(key).delete();
    }
  };
}

async function getOAuthClient() {
  const client = new NodeOAuthClient({
    // This object will be used to build the payload of the /client-metadata.json
    // endpoint metadata, exposing the client metadata to the OAuth server.
    clientMetadata: clientMetadata,

    // Used to authenticate the client to the token endpoint. Will be used to
    // build the jwks object to be exposed on the "jwks_uri" endpoint.
    keyset: await getKeySet(),

    // Interface to store authorization state data (during authorization flows)
    stateStore: getStore('state'),

    // Interface to store authenticated session data
    sessionStore: getStore('sessions'),

    // A lock to prevent concurrent access to the session store. Optional if only one instance is running.
    //requestLock,
  })
  return client;
}

async function getChannelProfile(channel) {
  try {
    console.log(`Getting profile for ${channel}`);
    var doc = await db.collection('profiles').doc(channel).get();
    var data = doc.data();
    console.log(data);
    return data || {};
  } catch (error) {
    console.error('Error getting document', error);
    return {};
  }
}

app.get('/', (req, res) => {
  res.send(homeHemplate({ host: host }));
});

app.get('/client-metadata.json', async (req, res) => {
  res.json(clientMetadata)
})
app.get('/jwks.json', async (req, res) => {
  var client = await getOAuthClient();
  
  // Copy 
  console.log("JWKS before copy...");
  console.log(client.jwks);


  var jwks = structuredClone(client.jwks);
  jwks.keys[0].kid = '1';
  console.log("JWKS NOW...")
  console.log(jwks);
  
  res.json(jwks) 
})

// Create an endpoint to initiate the OAuth flow
app.get('/login', async (req, res, next) => {
  try {
    const handle = req.query.handle;
    const state = Math.random().toString(36).substring(7);
    const client = await getOAuthClient();
    const url = await client.authorize(handle, {
      state
    })

    res.redirect(url)
  } 
  catch (err) {
    next(err)
  }
});

// Create an endpoint to handle the OAuth callback
app.get('/callback', async (req, res, next) => {
  try {
    const params = new URLSearchParams(req.url.split('?')[1])
    const client = await getOAuthClient();
    console.log(params);
    const { session, state } = await client.callback(params)

    // Process successful authentication here
    console.log('authorize() was called with state:', state)
    console.log('User authenticated as:', session.did)

    var token = await auth.createCustomToken(session.did)

    const agent = new Agent(session)

    // Make Authenticated API calls
    const profile = await agent.getProfile({ actor: agent.did })
    console.log('Bsky profile:', profile.data)

    res.json({ ok: true, token:token, profile: profile.data })
  } 
  catch (err) {
    next(err)
  }
})

app.get('/oembed', async (req, res) => {
  var host = req.hostname;
  var url = req.query.url;
  var channel = url.split('/')[3];
  var profile = await getChannelProfile(channel);

  var width = 560;
  var height = 315;

  if (req.query.maxwidth) {
    width = Math.min(width, parseInt(req.query.maxwidth));
    height = Math.round(width * (9/16));
  }
  if (req.query.maxheight) {
    height = Math.min(height, parseInt(req.query.maxheight));
    width = Math.round(height * (16/9));
  }

  res.send({
    "version": "1.0",
    "type": "video",
    "provider_name": "StreamTooth",
    "provider_url": `https://${host}`,
    "title": profile.name || channel,
    "author_name": channel,
    "author_url": `https://${host}/${channel}`,
    "height": height,
    "width": width,
    "html": `<iframe src="https://${host}/${channel}?view=embed" width="${width}" height="${height}" frameborder="0" scrolling="no" allowfullscreen></iframe>`,
  });
});

app.get('/:channel', async (req, res) => {
  var channel = req.params.channel;
  var host = req.hostname;
  var profile = await getChannelProfile(channel);
  console.log(profile);

  var title = profile.name || `${channel} live using StreamTooth`;
  var siteName = 'StreamTooth';
  var oembedUrl = `https://${host}/oembed/?url=https%3A%2F%2Fs2th.tv%2F${channel}&format=json`;
  var url = `https://${host}/${channel}`;
  var embedUrl = `https://${host}/${channel}?view=embed`;
  var description = profile.description || "StreamTooth is a platform for peer to peer live streaming video";
  var image = profile.imageBanner || `https://${host}/s/frame.jpg`;
  var jsonld =  {"@context":"http://schema.org",
    "@graph":[{
      "@type":"VideoObject",
      "description":description,
      "contentUrl":url,
      "embedUrl":embedUrl,
      "name":title,
      "thumbnailUrl":[image],
      "uploadDate":new Date().toISOString(),
      "publication":{
        "@type":"BroadcastEvent",
        "endDate":new Date(Date.now() + (3600 * 1000 * 24)).toISOString(),
        "startDate":new Date().toISOString(),
        "isLiveBroadcast":true
      }
    }]
  }
  
  res.setHeader('Link', `<${oembedUrl}>; rel="alternate"; type="application/json+oembed"`);
  res.send(playTemplate({
    siteName: siteName,
    title: title,
    description: description,
    url: url,
    channel: channel,
    embedUrl: embedUrl,
    oembedUrl: oembedUrl, 
    image: image,
    host: host,
    jsonld: JSON.stringify(jsonld),
  }));
});

exports._express = app;
exports.app = functions.https.onRequest(app);
