const bcrypt = require('bcrypt');
const password = 'Operador1234';
bcrypt.hash(password, 10).then(console.log);
