const jwt = require('jsonwebtoken');
const { jwt: jwtConfig } = require('../configs/app.config');

const generateAccessToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      username: user.username,
      role: user.role,
      branch: user.branch,
    },
    jwtConfig.secret,
    { expiresIn: jwtConfig.expire }
  );
};

const generateRefreshToken = (user) => {
  return jwt.sign(
    { id: user._id },
    jwtConfig.secret,
    { expiresIn: jwtConfig.refreshExpire }
  );
};

const verifyToken = (token) => {
  return jwt.verify(token, jwtConfig.secret);
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
};
