import { bytesToHex, hexToBytes, keccak256, sliceHex, type Address, type Hex } from "viem";

export interface ParsedHeader {
  version: number;
  nonce: bigint;
  srcEid: number;
  sender: Hex;
  dstEid: number;
  receiver: Hex;
}

export interface DecodedPacket extends ParsedHeader {
  header: Hex;
  payloadHash: Hex;
  guid: Hex;
  message: Hex;
}

function unsigned(bytes: Uint8Array): bigint {
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

export function parsePacketHeader(header: Hex): ParsedHeader {
  const bytes = hexToBytes(header);
  if (bytes.length !== 81) throw new Error(`LayerZero packet header must be 81 bytes, got ${bytes.length}`);
  return {
    version: bytes[0],
    nonce: unsigned(bytes.slice(1, 9)),
    srcEid: Number(unsigned(bytes.slice(9, 13))),
    sender: bytesToHex(bytes.slice(13, 45)),
    dstEid: Number(unsigned(bytes.slice(45, 49))),
    receiver: bytesToHex(bytes.slice(49, 81)),
  };
}

export function addressAsBytes32(address: Address): Hex {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

export function feltAsBytes32(address: Hex): Hex {
  return `0x${BigInt(address).toString(16).padStart(64, "0")}`;
}

export function splitEncodedPacket(packet: Hex): { header: Hex; payloadHash: Hex } {
  const decoded = decodeEncodedPacket(packet);
  return { header: decoded.header, payloadHash: decoded.payloadHash };
}

export function decodeEncodedPacket(packet: Hex): DecodedPacket {
  const bytes = hexToBytes(packet);
  if (bytes.length < 113) throw new Error("LayerZero encoded packet is shorter than header plus GUID");
  const header = sliceHex(packet, 0, 81);
  return {
    ...parsePacketHeader(header),
    header,
    payloadHash: keccak256(sliceHex(packet, 81)),
    guid: sliceHex(packet, 81, 113),
    message: sliceHex(packet, 113),
  };
}
