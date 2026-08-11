use starknet::ContractAddress;

/// ABI-compatible with LayerZero's lz_utils::bytes::Bytes32.
#[derive(Drop, Serde, Copy)]
pub struct Bytes32 {
    pub value: u256,
}

#[starknet::interface]
pub trait IMessageLib<TContractState> {
    fn verify(
        ref self: TContractState,
        packet_header: ByteArray,
        payload_hash: Bytes32,
        confirmations: u64,
    );
}

#[starknet::interface]
pub trait IMiniDVN<TContractState> {
    fn verify_packet(
        ref self: TContractState,
        packet_header: ByteArray,
        payload_hash: Bytes32,
        confirmations: u64,
    );
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
    fn get_owner(self: @TContractState) -> ContractAddress;
    fn get_receive_uln(self: @TContractState) -> ContractAddress;
}

#[starknet::contract]
pub mod MiniDVN {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use super::{Bytes32, IMessageLibDispatcher, IMessageLibDispatcherTrait, IMiniDVN};

    #[storage]
    struct Storage {
        owner: ContractAddress,
        receive_uln: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        PacketVerified: PacketVerified,
        OwnershipTransferred: OwnershipTransferred,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PacketVerified {
        #[key]
        pub payload_hash_low: u128,
        #[key]
        pub payload_hash_high: u128,
        pub confirmations: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipTransferred {
        #[key]
        pub previous_owner: ContractAddress,
        #[key]
        pub new_owner: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress, receive_uln: ContractAddress) {
        let owner_felt: felt252 = owner.into();
        let uln_felt: felt252 = receive_uln.into();
        assert(owner_felt != 0, 'owner is zero');
        assert(uln_felt != 0, 'uln is zero');
        self.owner.write(owner);
        self.receive_uln.write(receive_uln);
    }

    #[abi(embed_v0)]
    impl MiniDVNImpl of IMiniDVN<ContractState> {
        fn verify_packet(
            ref self: ContractState,
            packet_header: ByteArray,
            payload_hash: Bytes32,
            confirmations: u64,
        ) {
            assert(get_caller_address() == self.owner.read(), 'caller not owner');
            IMessageLibDispatcher { contract_address: self.receive_uln.read() }
                .verify(packet_header, payload_hash, confirmations);
            self
                .emit(
                    PacketVerified {
                        payload_hash_low: payload_hash.value.low,
                        payload_hash_high: payload_hash.value.high,
                        confirmations,
                    },
                );
        }

        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            assert(get_caller_address() == self.owner.read(), 'caller not owner');
            let owner_felt: felt252 = new_owner.into();
            assert(owner_felt != 0, 'owner is zero');
            let previous_owner = self.owner.read();
            self.owner.write(new_owner);
            self.emit(OwnershipTransferred { previous_owner, new_owner });
        }

        fn get_owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn get_receive_uln(self: @ContractState) -> ContractAddress {
            self.receive_uln.read()
        }
    }
}
