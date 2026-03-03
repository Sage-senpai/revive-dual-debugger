// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Counter.sol — Demo contract for ReviveDualDebugger
 *
 * A simple stateful counter demonstrating:
 *   - Storage reads/writes (seal_get_storage / seal_set_storage in PVM)
 *   - Event emission (seal_deposit_event in PVM)
 *   - Value transfers (seal_transfer in PVM)
 *   - Access control (seal_caller in PVM)
 *   - Cross-contract calls (seal_call in PVM)
 *
 * Usage:
 *   1. Open this file in VS Code
 *   2. Press F5 (or use "Revive: One-Click Deploy & Debug")
 *   3. Select "Debug Solidity (Dual VM)" configuration
 *   4. Step through execution — observe REVM opcodes vs PVM syscalls
 */
contract Counter {
    // ── Storage ────────────────────────────────────────────────────────────
    uint256 private _count;
    address private _owner;
    uint256 private _stepSize;
    bool private _paused;

    // ── Events ─────────────────────────────────────────────────────────────
    event CounterIncremented(address indexed by, uint256 newValue, uint256 delta);
    event CounterDecremented(address indexed by, uint256 newValue, uint256 delta);
    event CounterReset(address indexed by);
    event StepSizeChanged(uint256 oldSize, uint256 newSize);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ── Errors ─────────────────────────────────────────────────────────────
    error NotOwner(address caller, address owner);
    error ContractPaused();
    error Underflow(uint256 current, uint256 delta);
    error InvalidStepSize();
    error InsufficientPayment(uint256 sent, uint256 required);

    // ── Constructor ────────────────────────────────────────────────────────

    /**
     * @param initialCount Starting counter value
     * @param stepSize      Default increment/decrement amount
     */
    constructor(uint256 initialCount, uint256 stepSize) {
        require(stepSize > 0, "Step size must be positive");
        _count = initialCount;
        _owner = msg.sender;
        _stepSize = stepSize;
        _paused = false;
    }

    // ── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != _owner) {
            revert NotOwner(msg.sender, _owner);
        }
        _;
    }

    modifier whenNotPaused() {
        if (_paused) {
            revert ContractPaused();
        }
        _;
    }

    // ── Core Functions ─────────────────────────────────────────────────────

    /**
     * Increment the counter by stepSize.
     * Emits CounterIncremented.
     *
     * In PVM trace: expect seal_caller, seal_get_storage (×2),
     *               seal_set_storage, seal_deposit_event
     */
    function increment() external whenNotPaused {
        uint256 current = _count;
        uint256 delta = _stepSize;
        uint256 newValue = current + delta;

        _count = newValue;

        emit CounterIncremented(msg.sender, newValue, delta);
    }

    /**
     * Increment by a custom amount.
     */
    function incrementBy(uint256 amount) external whenNotPaused {
        if (amount == 0) revert InvalidStepSize();

        uint256 newValue = _count + amount;
        _count = newValue;

        emit CounterIncremented(msg.sender, newValue, amount);
    }

    /**
     * Decrement the counter by stepSize.
     * Reverts if counter would go below zero.
     *
     * In PVM trace: expect seal_get_storage (×2), seal_set_storage,
     *               seal_deposit_event OR seal_revert on underflow
     */
    function decrement() external whenNotPaused {
        uint256 current = _count;
        uint256 delta = _stepSize;

        if (delta > current) {
            revert Underflow(current, delta);
        }

        uint256 newValue = current - delta;
        _count = newValue;

        emit CounterDecremented(msg.sender, newValue, delta);
    }

    /**
     * Reset counter to zero. Owner only.
     *
     * In PVM trace: expect seal_caller, seal_get_storage, seal_set_storage,
     *               seal_deposit_event
     */
    function reset() external onlyOwner {
        _count = 0;
        emit CounterReset(msg.sender);
    }

    /**
     * Change the default step size. Owner only.
     */
    function setStepSize(uint256 newSize) external onlyOwner {
        if (newSize == 0) revert InvalidStepSize();
        uint256 old = _stepSize;
        _stepSize = newSize;
        emit StepSizeChanged(old, newSize);
    }

    /**
     * Pause the contract. Owner only.
     */
    function pause() external onlyOwner {
        _paused = true;
        emit Paused(msg.sender);
    }

    /**
     * Unpause the contract. Owner only.
     */
    function unpause() external onlyOwner {
        _paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * Payable increment — requires 0.001 ether payment.
     * Demonstrates seal_value_transferred and seal_transfer in PVM.
     */
    function incrementWithPayment() external payable whenNotPaused {
        uint256 required = 0.001 ether;
        if (msg.value < required) {
            revert InsufficientPayment(msg.value, required);
        }

        uint256 newValue = _count + _stepSize;
        _count = newValue;
        emit CounterIncremented(msg.sender, newValue, _stepSize);

        // Refund excess payment
        if (msg.value > required) {
            uint256 refund = msg.value - required;
            (bool ok,) = payable(msg.sender).call{value: refund}("");
            require(ok, "Refund failed");
        }
    }

    /**
     * Batch increment — useful for testing multiple storage writes.
     * Demonstrates repeated seal_get_storage + seal_set_storage patterns.
     */
    function batchIncrement(uint256 times) external whenNotPaused {
        require(times > 0 && times <= 10, "1-10 iterations only");
        for (uint256 i = 0; i < times; i++) {
            _count += _stepSize;
        }
        emit CounterIncremented(msg.sender, _count, _stepSize * times);
    }

    // ── View Functions ─────────────────────────────────────────────────────

    function count() external view returns (uint256) {
        return _count;
    }

    function owner() external view returns (address) {
        return _owner;
    }

    function stepSize() external view returns (uint256) {
        return _stepSize;
    }

    function paused() external view returns (bool) {
        return _paused;
    }

    /**
     * Compute fee estimation for one increment.
     * Useful for testing seal_weight_to_fee in PVM traces.
     */
    function estimatedGasCost() external pure returns (uint256) {
        // SLOAD × 2 + SSTORE × 1 + event LOG3
        // Approximate EVM gas: 2×2100 + 20000 + 1375 = 45575
        return 45_575;
    }

    // ── Receive / Fallback ─────────────────────────────────────────────────

    receive() external payable {}
}
