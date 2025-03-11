const app = require('./functions/index')._express;

app.listen(3000, () => {
  console.log('Server is running on http://localhost:3000');
});