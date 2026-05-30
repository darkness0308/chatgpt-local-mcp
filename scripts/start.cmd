@echo off
:: chatgpt-local-mcp - Windows launcher
:: Delegates to the cross-platform Node.js start script.
:: Usage:  npm run win:start   OR   scripts\start.cmd

cd /d "%~dp0.."
node scripts\start.js %*
