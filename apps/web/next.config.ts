import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  reactStrictMode: true,
  transpilePackages: [
    '@schemora/assembly-plan',
    '@schemora/catalog',
    '@schemora/circuit-model',
    '@schemora/contracts',
    '@schemora/simulation',
    '@schemora/teaching',
    '@schemora/validation',
  ],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default config;
