import { parseAbi } from "viem";

export const EVM_RECEIVE_DVN_ABI = parseAbi([
  "function verifyPacket(bytes packetHeader, bytes32 payloadHash, uint64 confirmations)",
]);

export const EVM_RECEIVE_ULN_ABI = parseAbi([
  "function commitVerification(bytes packetHeader, bytes32 payloadHash)",
]);

export const EVM_ENDPOINT_ABI = parseAbi([
  "function lzReceive((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable",
  "function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) view returns (bytes32)",
]);

export const STARKNET_MINI_DVN_ABI = [
  {
    type: "struct",
    name: "core::integer::u256",
    members: [
      { name: "low", type: "core::integer::u128" },
      { name: "high", type: "core::integer::u128" },
    ],
  },
  {
    type: "struct",
    name: "core::byte_array::ByteArray",
    members: [
      { name: "data", type: "core::array::Array::<core::bytes_31::bytes31>" },
      { name: "pending_word", type: "core::felt252" },
      { name: "pending_word_len", type: "core::internal::bounded_int::BoundedInt::<0, 30>" },
    ],
  },
  {
    type: "struct",
    name: "mini_dvn::mini_dvn::Bytes32",
    members: [{ name: "value", type: "core::integer::u256" }],
  },
  {
    type: "impl",
    name: "MiniDVNImpl",
    interface_name: "mini_dvn::mini_dvn::IMiniDVN",
  },
  {
    type: "interface",
    name: "mini_dvn::mini_dvn::IMiniDVN",
    items: [
      {
        type: "function",
        name: "verify_packet",
        inputs: [
          { name: "packet_header", type: "core::byte_array::ByteArray" },
          { name: "payload_hash", type: "mini_dvn::mini_dvn::Bytes32" },
          { name: "confirmations", type: "core::integer::u64" },
        ],
        outputs: [],
        state_mutability: "external",
      },
      {
        type: "function",
        name: "get_owner",
        inputs: [],
        outputs: [{ type: "core::starknet::contract_address::ContractAddress" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "get_receive_uln",
        inputs: [],
        outputs: [{ type: "core::starknet::contract_address::ContractAddress" }],
        state_mutability: "view",
      },
    ],
  },
] as const;

export const STARKNET_ERC20_ABI = [
  {
    type: "struct",
    name: "core::integer::u256",
    members: [
      { name: "low", type: "core::integer::u128" },
      { name: "high", type: "core::integer::u128" },
    ],
  },
  {
    type: "function",
    name: "balance_of",
    inputs: [{ name: "account", type: "core::starknet::contract_address::ContractAddress" }],
    outputs: [{ type: "core::integer::u256" }],
    state_mutability: "view",
  },
] as const;
