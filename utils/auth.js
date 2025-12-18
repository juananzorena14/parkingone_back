const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

function signUser(user){
  return jwt.sign({ id:user.id, role:user.role, email:user.email }, process.env.JWT_SECRET, { expiresIn: '8h' });
}

async function verifyPassword(plain, hash){
  return bcrypt.compare(plain, hash);
}

module.exports = { signUser, verifyPassword };
