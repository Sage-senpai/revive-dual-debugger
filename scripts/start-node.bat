@echo off
echo Starting revive-dev-node + eth-rpc in WSL...

:: Start revive-dev-node in a new WSL window
start "revive-dev-node" wsl -d Ubuntu bash -c "/mnt/c/Users/USER/RevdDebugger/bin/linux/revive-dev-node --dev 2>&1 | tee /tmp/revive-node.log"

:: Wait for node to be ready on port 9944
echo Waiting for node to start on port 9944...
:WAIT_NODE
timeout /t 2 /nobreak >nul
wsl -d Ubuntu bash -c "curl -sf http://127.0.0.1:9944 -o /dev/null -X POST -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"method\":\"system_health\",\"params\":[],\"id\":1}'" >nul 2>&1
if errorlevel 1 goto WAIT_NODE
echo Node is up!

:: Start eth-rpc in a new WSL window
start "eth-rpc" wsl -d Ubuntu bash -c "/mnt/c/Users/USER/RevdDebugger/bin/linux/eth-rpc --dev 2>&1 | tee /tmp/eth-rpc.log"

echo Waiting for eth-rpc to start on port 8545...
:WAIT_RPC
timeout /t 2 /nobreak >nul
wsl -d Ubuntu bash -c "curl -sf http://127.0.0.1:8545 -o /dev/null -X POST -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}'" >nul 2>&1
if errorlevel 1 goto WAIT_RPC
echo eth-rpc is up!

echo.
echo Both services running. Press any key to stop all.
pause >nul

:: Cleanup
wsl -d Ubuntu bash -c "pkill -f revive-dev-node; pkill -f eth-rpc"
echo Stopped.
