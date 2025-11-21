#!/usr/bin/env node

/**
 * Post-build script to fix MCP SDK import extensions
 * Pkgroll incorrectly transforms .js extensions to .ts for MCP SDK imports
 * This script fixes them back to .js
 */

import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';

const files = glob.sync('dist/**/*.{mjs,cjs}');

files.forEach(file => {
  let content = readFileSync(file, 'utf-8');
  const original = content;

  // Fix MCP SDK imports: .ts -> .js
  content = content.replace(
    /@modelcontextprotocol\/sdk\/([^'"]*)\.ts(['"])/g,
    '@modelcontextprotocol/sdk/$1.js$2'
  );

  if (content !== original) {
    writeFileSync(file, content, 'utf-8');
    console.log(`Fixed MCP imports in ${file}`);
  }
});

console.log('MCP import fix complete');
