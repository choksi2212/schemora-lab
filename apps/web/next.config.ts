import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  reactStrictMode: true,
  transpilePackages: ['@schemora/contracts'],
};

export default config;
