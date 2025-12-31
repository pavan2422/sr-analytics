const { PHASE_DEVELOPMENT_SERVER } = require('next/constants');

/** @type {import('next').NextConfig} */
const baseConfig = {
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
    };
    return config;
  },
};

module.exports = (phase) => {
  // CRITICAL: keep dev and build outputs separate to avoid `.next` corruption,
  // which causes broken refresh / missing chunk files.
  const distDir = phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next';
  // echarts-for-react is not React StrictMode dev-compatible (double unmount triggers resizeObserver errors).
  const reactStrictMode = phase === PHASE_DEVELOPMENT_SERVER ? false : true;
  return { ...baseConfig, distDir, reactStrictMode };
};








