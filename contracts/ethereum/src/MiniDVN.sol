// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice LayerZero V2 DVN worker interface used by SendUln302.
interface ILayerZeroDVN {
    struct AssignJobParam {
        uint32 dstEid;
        bytes packetHeader;
        bytes32 payloadHash;
        uint64 confirmations;
        address sender;
    }

    function assignJob(AssignJobParam calldata param, bytes calldata options)
        external
        payable
        returns (uint256 fee);

    function getFee(uint32 dstEid, uint64 confirmations, address sender, bytes calldata options)
        external
        view
        returns (uint256 fee);
}

/// @notice A zero-fee, single-route LayerZero DVN job sink for ArcX Sepolia testing.
/// @dev This contract deliberately does not verify packets. It authenticates the canonical
///      SendUln/OApp route and emits the exact verification material for the manual relay.
contract MiniDVN is ILayerZeroDVN {
    error CallerNotOwner();
    error OnlySendUln(address caller);
    error InvalidDestination(uint32 actual);
    error InvalidSender(address actual);
    error UnexpectedFee(uint256 actual);
    error ZeroAddress();

    address public owner;
    address public sendUln;
    address public oapp;
    uint32 public destinationEid;
    uint64 public nextJobId;

    event RouteConfigured(address indexed sendUln, address indexed oapp, uint32 destinationEid);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    event JobAssigned(
        uint64 indexed jobId,
        uint32 indexed dstEid,
        address indexed sender,
        bytes packetHeader,
        bytes32 payloadHash,
        uint64 confirmations
    );

    constructor(address owner_, address sendUln_, address oapp_, uint32 destinationEid_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        _setRoute(sendUln_, oapp_, destinationEid_);
    }

    function setRoute(address sendUln_, address oapp_, uint32 destinationEid_) external {
        if (msg.sender != owner) revert CallerNotOwner();
        _setRoute(sendUln_, oapp_, destinationEid_);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert CallerNotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function _setRoute(address sendUln_, address oapp_, uint32 destinationEid_) private {
        if (sendUln_ == address(0) || oapp_ == address(0)) revert ZeroAddress();
        sendUln = sendUln_;
        oapp = oapp_;
        destinationEid = destinationEid_;
        emit RouteConfigured(sendUln_, oapp_, destinationEid_);
    }

    function getFee(uint32 dstEid, uint64, address sender, bytes calldata)
        external
        view
        returns (uint256)
    {
        _validate(msg.sender, dstEid, sender);
        return 0;
    }

    function assignJob(AssignJobParam calldata param, bytes calldata)
        external
        payable
        returns (uint256)
    {
        _validate(msg.sender, param.dstEid, param.sender);
        if (msg.value != 0) revert UnexpectedFee(msg.value);

        uint64 jobId = nextJobId++;
        emit JobAssigned(
            jobId,
            param.dstEid,
            param.sender,
            param.packetHeader,
            param.payloadHash,
            param.confirmations
        );
        return 0;
    }

    function _validate(address caller, uint32 dstEid, address sender) private view {
        if (caller != sendUln) revert OnlySendUln(caller);
        if (dstEid != destinationEid) revert InvalidDestination(dstEid);
        if (sender != oapp) revert InvalidSender(sender);
    }
}
