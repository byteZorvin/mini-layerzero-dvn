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

    address public owner;
    address public receiveUln;
    uint32 public sourceEid;
    bytes32 public sourceOapp;
    uint32 public destinationEid;
    bytes32 public destinationOapp;
    uint64 public expectedConfirmations;

    event PacketVerified(bytes32 indexed payloadHash, uint64 confirmations);
    event RouteConfigured(
        address indexed receiveUln,
        uint32 sourceEid,
        bytes32 indexed sourceOapp,
        uint32 destinationEid,
        bytes32 indexed destinationOapp,
        uint64 expectedConfirmations
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(
        address owner_,
        address receiveUln_,
        uint32 sourceEid_,
        bytes32 sourceOapp_,
        uint32 destinationEid_,
        bytes32 destinationOapp_,
        uint64 expectedConfirmations_
    ) {
        if (owner_ == address(0)) revert InvalidAddress();
        owner = owner_;
        _setRoute(
            receiveUln_,
            sourceEid_,
            sourceOapp_,
            destinationEid_,
            destinationOapp_,
            expectedConfirmations_
        );
    }

    function setRoute(
        address receiveUln_,
        uint32 sourceEid_,
        bytes32 sourceOapp_,
        uint32 destinationEid_,
        bytes32 destinationOapp_,
        uint64 expectedConfirmations_
    ) external {
        if (msg.sender != owner) revert CallerNotOwner();
        _setRoute(
            receiveUln_,
            sourceEid_,
            sourceOapp_,
            destinationEid_,
            destinationOapp_,
            expectedConfirmations_
        );
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert CallerNotOwner();
        if (newOwner == address(0)) revert InvalidAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function _setRoute(
        address receiveUln_,
        uint32 sourceEid_,
        bytes32 sourceOapp_,
        uint32 destinationEid_,
        bytes32 destinationOapp_,
        uint64 expectedConfirmations_
    ) private {
        if (receiveUln_ == address(0) || sourceOapp_ == bytes32(0) || destinationOapp_ == bytes32(0)) {
            revert InvalidAddress();
        }
        receiveUln = receiveUln_;
        sourceEid = sourceEid_;
        sourceOapp = sourceOapp_;
        destinationEid = destinationEid_;
        destinationOapp = destinationOapp_;
        expectedConfirmations = expectedConfirmations_;
        emit RouteConfigured(
            receiveUln_,
            sourceEid_,
            sourceOapp_,
            destinationEid_,
            destinationOapp_,
            expectedConfirmations_
        );
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
