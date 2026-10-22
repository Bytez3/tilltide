// The owner web app is served by the API under /app (EXPO_BASE_URL=/app); the demo and dev serve it at /.
module.exports = ({ config }) => ({
  ...config,
  experiments: { ...config.experiments, ...(process.env.EXPO_BASE_URL ? { baseUrl: process.env.EXPO_BASE_URL } : {}) },
})
