require('dotenv').config();

const app = require('./app');

const port = process.env.PORT || 3001;
app.listen(port, '0.0.0.0', () => console.log(`API en http://0.0.0.0:${port}`));
