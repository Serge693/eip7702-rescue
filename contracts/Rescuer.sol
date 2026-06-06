// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title Rescuer
 * @notice Stateless EIP-7702 rescue contract.
 *
 * Deployed ONCE per network. Any compromised wallet delegates to this address
 * via EIP-7702, then the sponsor calls one of the rescue functions.
 *
 * Key design:
 *  - No constructor args, no storage — fully stateless.
 *  - destination is always passed as calldata (never stored).
 *  - claimAndSweepAll: atomic claim + sweep of ALL tokens found.
 *  - sweepAll: sweep without claim (for airdrops that arrive directly).
 *  - receive(): silently accepts ETH (auto-forwarding handled off-chain via sweepAll).
 *
 * Compiled: solc 0.8.23, optimizer 200 runs.
 */
contract Rescuer {

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error ClaimFailed(bytes reason);
    error EthTransferFailed();
    error TokenTransferFailed(address token);

    // ─────────────────────────────────────────────────────────────────────────
    // Receive — accept ETH silently (airdrops, unwraps, etc.)
    // ─────────────────────────────────────────────────────────────────────────

    receive() external payable {}

    // ─────────────────────────────────────────────────────────────────────────
    // claimAndSweepAll
    //
    // Atomic: claim → sweep ETH → sweep all tokens with non-zero balance.
    //
    // @param claimContract  Address of the claim/vesting contract to call.
    // @param claimData      Calldata to send to claimContract.
    // @param tokens         Candidate token addresses to sweep after claim.
    //                       Pass every token you suspect might arrive.
    //                       Tokens with zero balance are silently skipped.
    // @param destination    Where all rescued assets go.
    // ─────────────────────────────────────────────────────────────────────────
    function claimAndSweepAll(
        address claimContract,
        bytes calldata claimData,
        address[] calldata tokens,
        address destination
    ) external {
        // 1. Claim
        (bool ok, bytes memory reason) = claimContract.call(claimData);
        if (!ok) revert ClaimFailed(reason);

        // 2. Sweep ETH
        _sweepEth(destination);

        // 3. Sweep all candidate tokens
        _sweepTokens(tokens, destination);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // sweepAll
    //
    // No claim — just sweep ETH and tokens.
    // Used by guard daemon when an airdrop arrives directly.
    //
    // @param tokens       Candidate token addresses.
    // @param destination  Where assets go.
    // ─────────────────────────────────────────────────────────────────────────
    function sweepAll(
        address[] calldata tokens,
        address destination
    ) external {
        _sweepEth(destination);
        _sweepTokens(tokens, destination);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // sweepEth — sweep only ETH (fast path for native airdrops)
    // ─────────────────────────────────────────────────────────────────────────
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

    /// @dev Calls ERC-20 balanceOf(address(this)). Returns 0 on failure.
    function _balanceOf(address token) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", address(this))
        );
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    /// @dev Calls ERC-20 transfer(destination, amount). Returns false on failure.
    function _transfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
        if (!ok) return false;
        // Handle tokens that return nothing (non-standard ERC-20)
        if (data.length == 0) return true;
        return abi.decode(data, (bool));
    }
}
