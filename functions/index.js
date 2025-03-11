const functions = require('firebase-functions/v1');
const express = require('express');
const handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');

const app = express();
const template = fs.readFileSync(path.join(__dirname, 'views', 'index.hbs'), 'utf8');
const compiledTemplate = handlebars.compile(template);
const defaultChannel = 'potate_oh_no'

app.get('/', (req, res) => {
  // Redirect to the default channel until we get a landing page
  res.redirect(`/${defaultChannel}`);
});

app.get('/oembed', (req, res) => {
  var url = req.query.url;
  var channel = url.split('/')[3];

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
    "provider_url": "https://s2th.tv",
    "title": channel,
    "author_name": channel,
    "author_url": `https://s2th.tv/${channel}`,
    "height": height,
    "width": width,
    "html": `<iframe src="https://s2th.tv/${channel}?view=embed" width="${width}" height="${height}" frameborder="0" scrolling="no" allowfullscreen></iframe>`,
  });
});

app.get('/:channel', (req, res) => {
  var oembedUrl = `https://s2th.tv/oembed/url=https%3A%2F%2Fs2th.tv%2F${req.params.channel}&format=json`;
  res.setHeader('Link', `<${oembedUrl}>; rel="alternate"; type="application/json+oembed"`);
  res.send(compiledTemplate({ 
    channel: req.params.channel,
  }));
});

exports._express = app;
exports.app = functions.https.onRequest(app);
