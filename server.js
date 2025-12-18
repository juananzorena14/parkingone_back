const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(helmet());

// Rutas
app.use('/auth', require('./routes/auth'));
app.use('/settings', require('./routes/settings'));
app.use('/rateplans', require('./routes/rateplans'));
app.use('/tickets', require('./routes/tickets'));
app.use('/payments', require('./routes/payments'));
app.use('/reports', require('./routes/reports'));
app.use('/subscribers', require('./routes/subscribers'));
app.use('/api/cash-shifts', require('./routes/cashShift'));

// Static público (para servir el HTML)
app.use('/public', express.static('public'));
app.use('/public', require('./routes/public'));

const port = process.env.PORT || 3001;
app.listen(port, "0.0.0.0",() => console.log(`API en http://0.0.0.0:${port}`));
