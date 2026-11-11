import { CcdAmount, ContractAddress, Parameter, ReceiveName, type ContractContext } from '@concordium/web-sdk';
import type { SimulateContractParam } from './client.js';

/** Translate common invocation fields; callers retain their distinct invoker and energy rules. */
export function contractContext(
  param: Pick<SimulateContractParam, 'contract' | 'method' | 'parameterHex' | 'amountMicroCcd'>,
): ContractContext {
  return {
    contract: ContractAddress.create(param.contract.index, param.contract.subindex),
    method: ReceiveName.fromString(param.method),
    parameter: param.parameterHex !== undefined ? Parameter.fromHexString(param.parameterHex) : Parameter.empty(),
    ...(param.amountMicroCcd !== undefined && { amount: CcdAmount.fromMicroCcd(param.amountMicroCcd) }),
  };
}
