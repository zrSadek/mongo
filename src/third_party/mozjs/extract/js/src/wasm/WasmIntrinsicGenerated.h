/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef wasm_WasmIntrinsicGenerated_h
#define wasm_WasmIntrinsicGenerated_h

/* This file is generated by wasm/GenerateInstrinsic.py. Do not edit! */

#define FOR_EACH_INTRINSIC(M) \
    M(I8VecMul, "i8vecmul", IntrI8VecMul, Args_Int32_GeneralInt32Int32Int32Int32General, Instance::intrI8VecMul, 0)\

#define DECLARE_INTRINSIC_SAS_PARAM_VALTYPES_I8VecMul {ValType::I32, ValType::I32, ValType::I32, ValType::I32}
#define DECLARE_INTRINSIC_PARAM_TYPES_I8VecMul 6, {_PTR, _I32, _I32, _I32, _I32, _PTR, _END}


#endif // wasm_WasmIntrinsicGenerated_h
