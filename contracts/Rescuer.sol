// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title Rescuer
 * @notice Stateless EIP-7702 rescue contract.
 *
 * TWO claim modes:
 *
 * 1. claimAndSweepAll — uses CALL.
 *    msg.sender = Rescuer contract address.
 *    Works for: claims that don't verify msg.sender (Hedgey, most merkle drops).
 *
 * 2. selfClaimAndSweep — uses DELEGATECALL.
 *    msg.sender = original caller (sponsor), address(this) = source wallet.
 *    Works for: signature-based claims (OFC, permit-style) where the
 *    signature is over (amount, deadline, msg.sender) and msg.sender
 *    must equal the compromised wallet address.
 *
 * Use selfClaimAndSweep when the claim contract verifies msg.sender
 * against a signature provided in calldata.
 */
contract Rescuer {

    error ClaimFailed(bytes reason);
    error EthTransferFailed();
    error TokenTransferFailed(address token);

    receive() external payable {}

    // ─────────────────────────────────────────────────────────────────────────
    // claimAndSweepAll — CALL (msg.sender = Rescuer)
    // Use for: Hedgey, standard merkle drops, anything not checking msg.sender
    // ─────────────────────────────────────────────────────────────────────────
    function claimAndSweepAll(
        address claimContract,
        bytes calldata claimData,
        address[] calldata tokens,
        address destination
    ) external {
        (bool ok, bytes memory reason) = claimContract.call(claimData);
        if (!ok) revert ClaimFailed(reason);
        _sweepEth(destination);
        _sweepTokens(tokens, destination);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // selfClaimAndSweep — DELEGATECALL (msg.sender preserved = sponsor,
    //                                   address(this) = source wallet)
    //
    // Use for: signature-based claims where signature covers msg.sender
    // and msg.sender must be the compromised wallet (e.g. OFC claim).
    //
    // WARNING: delegatecall runs the claim contract's code in the context
    // of the source wallet. Only use with trusted, audited claim contracts.
    // ─────────────────────────────────────────────────────────────────────────
    function selfClaimAndSweep(
        address claimContract,
        bytes calldata claimData,
        address[] calldata tokens,
        address destination
    ) external {
        (bool ok, bytes memory reason) = claimContract.delegatecall(claimData);
        if (!ok) revert ClaimFailed(reason);
        _sweepEth(destination);
        _sweepTokens(tokens, destination);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // sweepAll — no claim, just sweep (for direct airdrops)
    // ─────────────────────────────────────────────────────────────────────────
    function sweepAll(
        address[] calldata tokens,
        address destination
    ) external {
        _sweepEth(destination);
        _sweepTokens(tokens, destination);
    }

    function sweepEth(address destination) external {
        _sweepEth(destination);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _sweepEth(address destination) internal {
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        (bool ok,) = destination.call{value: bal}("");
        if (!ok) revert EthTransferFailed();
    }

    function _sweepTokens(address[] calldata tokens, address destination) internal {
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 bal = _balanceOf(token);
            if (bal == 0) continue;
            bool ok = _transfer(token, destination, bal);
            if (!ok) revert TokenTransferFailed(token);
        }
    }

    function _balanceOf(address token) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", address(this))
        );
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function _transfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
        if (!ok) return false;
        if (data.length == 0) return true;
        return abi.decode(data, (bool));
    }
}
