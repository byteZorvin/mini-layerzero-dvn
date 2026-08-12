// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ILayerZeroDVN, MiniDVN} from "../src/MiniDVN.sol";

contract WrongCaller {
    function quote(MiniDVN dvn, uint32 dstEid, address sender) external view returns (uint256) {
        return dvn.getFee(dstEid, 15, sender, "");
    }

    function configure(MiniDVN dvn, address sendUln, address oapp, uint32 dstEid) external {
        dvn.setRoute(sendUln, oapp, dstEid);
    }
}

contract MiniDVNTest {
    address internal constant OAPP = address(0x1234);
    uint32 internal constant DST_EID = 40500;

    MiniDVN internal dvn;

    constructor() {
        dvn = new MiniDVN(address(this), address(this), OAPP, DST_EID);
    }

    function testQuoteAndAssignAreZeroFee() external {
        require(dvn.getFee(DST_EID, 15, OAPP, "") == 0, "nonzero quote");
        ILayerZeroDVN.AssignJobParam memory job = ILayerZeroDVN.AssignJobParam({
            dstEid: DST_EID,
            packetHeader: hex"010203",
            payloadHash: keccak256("payload"),
            confirmations: 15,
            sender: OAPP
        });
        require(dvn.assignJob(job, "") == 0, "nonzero assignment fee");
        require(dvn.nextJobId() == 1, "job id not incremented");
    }

    function testRejectsWrongRoute() external {
        try dvn.getFee(DST_EID + 1, 15, OAPP, "") returns (uint256) {
            revert("accepted wrong destination");
        } catch {}

        try dvn.getFee(DST_EID, 15, address(0x9999), "") returns (uint256) {
            revert("accepted wrong sender");
        } catch {}
    }

    function testRejectsWrongCaller() external {
        WrongCaller caller = new WrongCaller();
        try caller.quote(dvn, DST_EID, OAPP) returns (uint256) {
            revert("accepted wrong caller");
        } catch {}
    }


    function testOwnerCanConfigureRoute() external {
        address nextOapp = address(0x5678);
        dvn.setRoute(address(this), nextOapp, DST_EID + 1);
        require(dvn.oapp() == nextOapp, "oapp not updated");
        require(dvn.destinationEid() == DST_EID + 1, "destination not updated");
        require(dvn.getFee(DST_EID + 1, 15, nextOapp, "") == 0, "updated route rejected");
    }

    function testNonOwnerCannotConfigureRoute() external {
        WrongCaller caller = new WrongCaller();
        try caller.configure(dvn, address(this), address(0x5678), DST_EID + 1) {
            revert("accepted non-owner configuration");
        } catch {}
    }
}
