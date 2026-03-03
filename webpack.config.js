//@ts-check
'use strict';

const path = require('path');

/** @type {import('webpack').Configuration[]} */
const config = [
  // Extension host bundle
  {
    target: 'node',
    mode: 'none',
    entry: './src/extension.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'extension.js',
      libraryTarget: 'commonjs2',
      devtoolModuleFilenameTemplate: '../[resource-path]'
    },
    externals: {
      vscode: 'commonjs vscode'
    },
    resolve: {
      extensions: ['.ts', '.js']
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader' }]
        }
      ]
    },
    devtool: 'nosources-source-map',
    infrastructureLogging: { level: 'log' }
  },
  // Debug Adapter bundle (runs as separate process)
  {
    target: 'node',
    mode: 'none',
    entry: './src/debugAdapter.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'debugAdapter.js',
      libraryTarget: 'commonjs2'
    },
    externals: {
      vscode: 'commonjs vscode'
    },
    resolve: {
      extensions: ['.ts', '.js']
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader' }]
        }
      ]
    },
    devtool: 'nosources-source-map'
  }
];

module.exports = config;
