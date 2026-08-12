use starknet::ContractAddress;

#[derive(Drop, Serde, Clone)]
pub struct QuoteParams {
    pub dst_eid: u32,
    pub sender: ContractAddress,
    pub confirmations: u64,
    pub calldata_size: u32,
    pub options: ByteArray,
}

#[starknet::interface]
pub trait ILayerZeroWorker<TContractState> {
    fn assign_job(ref self: TContractState, params: QuoteParams) -> u256;
    fn quote(self: @TContractState, params: QuoteParams) -> u256;
}

#[starknet::interface]
pub trait IMiniDVNSend<TContractState> {
    fn set_route(
        ref self: TContractState,
        send_uln: ContractAddress,
        oapp: ContractAddress,
        destination_eid: u32,
        expected_confirmations: u64,
    );
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
    fn get_owner(self: @TContractState) -> ContractAddress;
    fn get_send_uln(self: @TContractState) -> ContractAddress;
    fn get_oapp(self: @TContractState) -> ContractAddress;
    fn get_destination_eid(self: @TContractState) -> u32;
    fn get_expected_confirmations(self: @TContractState) -> u64;
}

#[starknet::contract]
pub mod MiniDVNSend {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use super::{ILayerZeroWorker, IMiniDVNSend, QuoteParams};

    #[storage]
    struct Storage {
        owner: ContractAddress,
        send_uln: ContractAddress,
        oapp: ContractAddress,
        destination_eid: u32,
        expected_confirmations: u64,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        RouteConfigured: RouteConfigured,
        OwnershipTransferred: OwnershipTransferred,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RouteConfigured {
        #[key]
        pub send_uln: ContractAddress,
        #[key]
        pub oapp: ContractAddress,
        pub destination_eid: u32,
        pub expected_confirmations: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipTransferred {
        #[key]
        pub previous_owner: ContractAddress,
        #[key]
        pub new_owner: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        send_uln: ContractAddress,
        oapp: ContractAddress,
        destination_eid: u32,
        expected_confirmations: u64,
    ) {
        let owner_felt: felt252 = owner.into();
        let send_uln_felt: felt252 = send_uln.into();
        let oapp_felt: felt252 = oapp.into();
        assert(owner_felt != 0, 'owner is zero');
        assert(send_uln_felt != 0, 'send uln is zero');
        assert(oapp_felt != 0, 'oapp is zero');
        self.owner.write(owner);
        self.send_uln.write(send_uln);
        self.oapp.write(oapp);
        self.destination_eid.write(destination_eid);
        self.expected_confirmations.write(expected_confirmations);
    }

    fn assert_route(self: @ContractState, params: @QuoteParams) {
        assert(*params.dst_eid == self.destination_eid.read(), 'wrong destination');
        assert(*params.sender == self.oapp.read(), 'wrong sender');
        assert(*params.confirmations == self.expected_confirmations.read(), 'wrong confirmations');
    }

    #[abi(embed_v0)]
    impl LayerZeroWorkerImpl of ILayerZeroWorker<ContractState> {
        fn assign_job(ref self: ContractState, params: QuoteParams) -> u256 {
            assert(get_caller_address() == self.send_uln.read(), 'caller not send uln');
            assert_route(@self, @params);
            0
        }

        fn quote(self: @ContractState, params: QuoteParams) -> u256 {
            assert_route(self, @params);
            0
        }
    }

    #[abi(embed_v0)]
    impl MiniDVNSendImpl of IMiniDVNSend<ContractState> {
        fn set_route(
            ref self: ContractState,
            send_uln: ContractAddress,
            oapp: ContractAddress,
            destination_eid: u32,
            expected_confirmations: u64,
        ) {
            assert(get_caller_address() == self.owner.read(), 'caller not owner');
            let send_uln_felt: felt252 = send_uln.into();
            let oapp_felt: felt252 = oapp.into();
            assert(send_uln_felt != 0, 'send uln is zero');
            assert(oapp_felt != 0, 'oapp is zero');
            self.send_uln.write(send_uln);
            self.oapp.write(oapp);
            self.destination_eid.write(destination_eid);
            self.expected_confirmations.write(expected_confirmations);
            self.emit(RouteConfigured { send_uln, oapp, destination_eid, expected_confirmations });
        }

        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            assert(get_caller_address() == self.owner.read(), 'caller not owner');
            let owner_felt: felt252 = new_owner.into();
            assert(owner_felt != 0, 'owner is zero');
            let previous_owner = self.owner.read();
            self.owner.write(new_owner);
            self.emit(OwnershipTransferred { previous_owner, new_owner });
        }

        fn get_owner(self: @ContractState) -> ContractAddress { self.owner.read() }
        fn get_send_uln(self: @ContractState) -> ContractAddress { self.send_uln.read() }
        fn get_oapp(self: @ContractState) -> ContractAddress { self.oapp.read() }
        fn get_destination_eid(self: @ContractState) -> u32 { self.destination_eid.read() }
        fn get_expected_confirmations(self: @ContractState) -> u64 { self.expected_confirmations.read() }
    }
}
