// SPDX-License-Identifier: MIT
pragma solidity =0.8.30;

interface IReceiveUln302 {
    function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external;
}

/// @notice Owner-operated receive-side DVN restricted to one ArcX LayerZero route.
contract MiniDVNReceive {
    error CallerNotOwner();
    error InvalidAddress();
    error InvalidPacketHeader();
    error InvalidConfirmations();

    address public immutable owner;
    address public immutable receiveUln;
    uint32 public immutable sourceEid;
    bytes32 public immutable sourceOapp;
    uint32 public immutable destinationEid;
    bytes32 public immutable destinationOapp;
    uint64 public immutable expectedConfirmations;

    event PacketVerified(bytes32 indexed payloadHash, uint64 confirmations);

    constructor(
        address owner_,
        address receiveUln_,
        uint32 sourceEid_,
        bytes32 sourceOapp_,
        uint32 destinationEid_,
        bytes32 destinationOapp_,
        uint64 expectedConfirmations_
    ) {
        if (owner_ == address(0) || receiveUln_ == address(0)) revert InvalidAddress();
        owner = owner_;
        receiveUln = receiveUln_;
        sourceEid = sourceEid_;
        sourceOapp = sourceOapp_;
        destinationEid = destinationEid_;
        destinationOapp = destinationOapp_;
        expectedConfirmations = expectedConfirmations_;
    }

    function verifyPacket(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external {
        if (msg.sender != owner) revert CallerNotOwner();
        if (confirmations != expectedConfirmations) revert InvalidConfirmations();
        if (packetHeader.length != 81 || uint8(packetHeader[0]) != 1) revert InvalidPacketHeader();

        uint32 packetSourceEid;
        bytes32 packetSourceOapp;
        uint32 packetDestinationEid;
        bytes32 packetDestinationOapp;
        assembly ("memory-safe") {
            packetSourceEid := shr(224, calldataload(add(packetHeader.offset, 9)))
            packetSourceOapp := calldataload(add(packetHeader.offset, 13))
            packetDestinationEid := shr(224, calldataload(add(packetHeader.offset, 45)))
            packetDestinationOapp := calldataload(add(packetHeader.offset, 49))
        }
        if (
            packetSourceEid != sourceEid || packetSourceOapp != sourceOapp
                || packetDestinationEid != destinationEid || packetDestinationOapp != destinationOapp
        ) revert InvalidPacketHeader();

        IReceiveUln302(receiveUln).verify(packetHeader, payloadHash, confirmations);
        emit PacketVerified(payloadHash, confirmations);
    }
}
