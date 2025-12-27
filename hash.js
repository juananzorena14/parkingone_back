const bcrypt = require('bcryptjs');
const password = 'Operador1234';
bcrypt.hash(password, 10).then(console.log);
