// SPDX-License-Identifier: MIT
pragma solidity =0.8.30;

import {IReceiveUln302, MiniDVNReceive} from "../src/MiniDVNReceive.sol";

contract MockReceiveUln is IReceiveUln302 {
    address public verifier;
    bytes32 public payloadHash;
    uint64 public confirmations;

    function verify(bytes calldata, bytes32 payloadHash_, uint64 confirmations_) external {
        verifier = msg.sender;
        payloadHash = payloadHash_;
        confirmations = confirmations_;
    }
}

contract OtherCaller {
    function verify(MiniDVNReceive dvn, bytes calldata header) external {
        dvn.verifyPacket(header, bytes32(uint256(1)), 15);
    }


    function configure(
        MiniDVNReceive dvn,
        address receiveUln,
        uint32 sourceEid,
        bytes32 sourceOapp,
        uint32 destinationEid,
        bytes32 destinationOapp,
        uint64 confirmations
    ) external {
        dvn.setRoute(receiveUln, sourceEid, sourceOapp, destinationEid, destinationOapp, confirmations);
    }
}

contract MiniDVNReceiveTest {
    uint32 internal constant SRC_EID = 40500;
    uint32 internal constant DST_EID = 40161;
    bytes32 internal constant SRC_OAPP = bytes32(uint256(0x1234));
    bytes32 internal constant DST_OAPP = bytes32(uint256(uint160(0x5678)));
    MockReceiveUln internal uln;
    MiniDVNReceive internal dvn;

    function setUp() public {
        uln = new MockReceiveUln();
        dvn = new MiniDVNReceive(address(this), address(uln), SRC_EID, SRC_OAPP, DST_EID, DST_OAPP, 15);
    }

    function header(uint32 source, bytes32 sender, uint32 destination, bytes32 receiver)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(uint8(1), uint64(7), source, sender, destination, receiver);
    }

    function testVerifiesOnlyConfiguredRoute() public {
        bytes32 payloadHash = keccak256("payload");
        dvn.verifyPacket(header(SRC_EID, SRC_OAPP, DST_EID, DST_OAPP), payloadHash, 15);
        require(uln.verifier() == address(dvn), "wrong verifier");
        require(uln.payloadHash() == payloadHash, "wrong payload");
        require(uln.confirmations() == 15, "wrong confirmations");
    }

    function testRejectsWrongRoute() public {
        (bool ok,) = address(dvn).call(
            abi.encodeCall(
                MiniDVNReceive.verifyPacket,
                (header(SRC_EID, bytes32(uint256(0x9999)), DST_EID, DST_OAPP), bytes32(uint256(1)), 15)
            )
        );
        require(!ok, "accepted wrong route");
    }

    function testRejectsWrongConfirmations() public {
        (bool ok,) = address(dvn).call(
            abi.encodeCall(
                MiniDVNReceive.verifyPacket,
                (header(SRC_EID, SRC_OAPP, DST_EID, DST_OAPP), bytes32(uint256(1)), 5)
            )
        );
        require(!ok, "accepted wrong confirmations");
    }

    function testRejectsWrongCaller() public {
        OtherCaller caller = new OtherCaller();
        (bool ok,) = address(caller).call(
            abi.encodeCall(OtherCaller.verify, (dvn, header(SRC_EID, SRC_OAPP, DST_EID, DST_OAPP)))
        );
        require(!ok, "accepted wrong caller");
    }


    function testOwnerCanConfigureRoute() public {
        bytes32 nextSourceOapp = bytes32(uint256(0x7777));
        bytes32 nextDestinationOapp = bytes32(uint256(uint160(0x8888)));
        dvn.setRoute(address(uln), SRC_EID + 1, nextSourceOapp, DST_EID + 1, nextDestinationOapp, 20);
        bytes32 payloadHash = keccak256("next payload");
        dvn.verifyPacket(
            header(SRC_EID + 1, nextSourceOapp, DST_EID + 1, nextDestinationOapp),
            payloadHash,
            20
        );
        require(uln.payloadHash() == payloadHash, "updated route rejected");
    }

    function testNonOwnerCannotConfigureRoute() public {
        OtherCaller caller = new OtherCaller();
        (bool ok,) = address(caller).call(
            abi.encodeCall(
                OtherCaller.configure,
                (dvn, address(uln), SRC_EID, SRC_OAPP, DST_EID, DST_OAPP, 15)
            )
        );
        require(!ok, "accepted non-owner configuration");
    }
}
