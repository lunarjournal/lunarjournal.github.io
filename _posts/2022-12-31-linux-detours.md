---
layout: post
title: A Tiny C (x86_64) Function Hooking Library
author: Dylan Müller
---

> Function detouring is a powerful hooking technique that allows for the
> interception of `C/C++` functions. `cdl86` aims to be a tiny `C` detours
> library for `x86_64` binaries.

1. [Overview](#overview)
2. [JMP Patching](#jmp-patching)
3. [INT3 Patching](#int3-patching)
4. [Code Injection](#code-injection)
5. [API](#api)
6. [Source Code](#source-code)

# Overview

Note: This article details the linux specific details of the library. Windows
support has since been added.

See:
[https://github.com/lunarjournal/cdl86](https://github.com/lunarjournal/cdl86)

[Microsoft Research](https://en.wikipedia.org/wiki/Microsoft_Research) currently
maintains a library known as [MS Detours](https://github.com/microsoft/Detours).
It allows for the interception of Windows `API` calls within the memory address
space of a process.

This might be useful in certain situations such as if you are writing a `D3D9`
(`DirectX`) hook and you need to intercept cetain graphics routines. This is
commonly done for `ESP` and wallhacks where the `Z-buffer` needs to be
disabled for certain character models, for `D3D9` this might involve hooking
`DrawIndexedPrimitive`.


```
HRESULT WINAPI hkDrawIndexedPrimitive(LPDIRECT3DDEVICE9 pDevice, ...args)
{
    // Check play model strides, primitive count, etc
    ...
    pDevice->SetRenderState(D3DRS_ZENABLE, false);
    ...
    // Call original function and return
    oDrawIndexedPrimitive(...)
    return ...
}
```

In order to disable the `Z-buffer` in this example we need access to a valid
`LPDIRECT3DDEVICE9` context within the running process. This is where detours
comes in handy. Generally, the procedure to hook a specific function is as
follows:

- Declare a function pointer with target function signature:

```
typedef HRESULT (WINAPI* tDrawIndexedPrimitive)(LPDIRECT3DDEVICE9 pDevice, ...args);
```

- Define detour function with same function signature:

```
HRESULT WINAPI hkDrawIndexedPrimitive(LPDIRECT3DDEVICE9 pDevice, ...args)
```

- Assign the function pointer the target functions address in memory. In this
  case a `VTable` entry.

```
#define DIP 0x55
tDrawIndexedPrimitive oDrawIndexedPrimitive = (oDrawIndexedPrimitive)SomeVTable[DIP];
```

- Call DetourFunction:

```
DetourFunction((void**)&oDrawIndexedPrimitive, &hkhkDrawIndexedPrimitive)
```

`DetourFunction` then uses the `oDrawIndexedPrimitive` function pointer and
modifies the instructions at the target function in order to transfer control
flow to the detour function.

At this point any calls to `DrawIndexedPrimitive` within the `LPDIRECT3DDEVICE9`
class will be rerouted to `hkDrawIndexedPrimitive`. You can see that this is a
very powerful concept and gives us access to the callee's function arguments. As
demonstrated, it is possible to hook both `C` and `C++` functions.

The difference generally is that the first argument to a `C++` function is a
hidden `this` pointer. Therefore you can define a `C++` detour in `C` with this
extra argument.

Detours is great, but it is only available for Windows. The aim of the `cdl86`
project is to create a simple, compact detours library for `x86_64` Linux. What
follows is a brief explanation on how the library was designed.

# Detour methods

Two different approaches to method detouring were investigated and implemented
in the `cdl86` `C` library. First let's have a look at a typical function call for a
simple `C` program. We will be using `GDB` to inspect the resulting disassembly.

```
#include <stdio.h>

int add(int x, int y)
{
    return x + y;
}
int main()
{
    printf("%i", add(1,1));
    return 0;
}
```

Compile with:
```
gcc main.c -o main
```

and then debug with `GDB`:

```
gdb main
```

To list all the functions in the binary, supply `info functions` to the `gdb`
command prompt.

```
0x0000000000001100  __do_global_dtors_aux
0x0000000000001140  frame_dummy
0x0000000000001149  add
0x0000000000001161  main
0x00000000000011a0  __libc_csu_init
0x0000000000001210  __libc_csu_fini
0x0000000000001218  _fini
```

Let's disassemble the main function with `disas /r main`:

```
Dump of assembler code for function main:
   0x0000000000001161 <+0>:     f3 0f 1e fa     endbr64
   0x0000000000001165 <+4>:     55      push   %rbp
   0x0000000000001166 <+5>:     48 89 e5        mov    %rsp,%rbp
   0x0000000000001169 <+8>:     be 01 00 00 00  mov    $0x1,%esi
   0x000000000000116e <+13>:    bf 01 00 00 00  mov    $0x1,%edi
   0x0000000000001173 <+18>:    e8 d1 ff ff ff  callq  0x1149 <add>
   0x0000000000001178 <+23>:    89 c6   mov    %eax,%esi
```

`callq` has one operand which is the address of the function being called. It
pushes the current value of `%rip` (next instruction after call) onto the stack
and then transfers control flow to the target function.

You may have also noticed the presence of the `endbr64` instruction. This
instruction is specific to Intel processors and is part of [Intel's Control-Flow
Enforcement Technology
(CET)](https://software.intel.com/content/www/us/en/develop/articles/technical-look-control-flow-enforcement-technology.html).
`CET` is designed to provide hardware protection against `ROP` (Return-orientated
Programming) and similar methods which manipulate control flow using *existing*
byte code.

It's two main features are:

* A shadow stack for tracking return addresses.
* Indirect branch tracking, which `endbr64` is a part of.

`Intel CET` however does not prevent us from modifying control flow **directly**
by inserting instructions into memory.

# JMP Patching

The first method of function detouring we will explore is by inserting a `JMP`
instruction at the beginning of the target function to transfer control over to
the detour function. It should be noted that in order to preserve the stack we
need to use a `JMP` (specifically `jmpq`) instruction rather than a `CALL`.

Since there is no way to pass a `64-bit` address to the `jmpq` instruction we will
have to first store the address we want to jump to into a register. We need to
choose a register that is not part of the `__cdecl` (defualt) calling
convention. `%rax` happens to be a register that is not part of the `__cdecl`
userspace calling convention and so for simplicity we use this register in our
design.

The following is a disassembly of the instructions required for a `JMP` to a
`64-bit` immediate address:

```
0x0000555555561389 <+0>: 48 b8 b1 13 56 55 55 55 00 00 movabs $0x5555555613b1,%rax
0x0000555555561393 <+10>: ff e0	jmpq   *%rax
```

You can see that `12` bytes are required to encode the `movabs` instruction (which
moves the detour address into `%rax`) as well as the `jmpq` instruction.
Immediate values are stored in little endian (LE) encoding.

So we can therefore conclude that we need to patch **at least** `12` bytes in
memory at the location of our target function. These `12` bytes however are
important and we cannot simply discard them. It turns out that we actually place
these bytes at the start of what I will call a 'trampoline function', it's
layout is as follows:

```
trampoline <0x23215412>:
    (original instruction bytes which were patched)
    JMP (target + JMP patch length)
```

Simply put, the trampoline function behaves as the original, unpatched function.
As shown above it consists of the target function's original instruction bytes
as well as a call to the target function, offset by the `JMP` patch length.

The trampoline generation code for `cdl86` is shown below:

```
uint8_t *cdl_gen_trampoline(uint8_t *target, uint8_t *bytes_orig, int size)
{
    uint8_t *trampoline;
    int prot = 0x0;
    int flags = 0x0;

    /* New function should have read, write and
     * execute permissions.
     */
    prot = PROT_READ | PROT_WRITE | PROT_EXEC;
    flags = MAP_PRIVATE | MAP_ANONYMOUS;

    /* We use mmap to allocate trampoline memory pool. */
    trampoline = mmap(NULL, size + BYTES_JMP_PATCH, prot, flags, -1, 0);
    memcpy(trampoline, bytes_orig, size);
    /* Generate jump to address just after call
     * to detour in trampoline. */
    cdl_gen_jmpq_rax(trampoline + size, target + size);

    return trampoline;
}
```

You can see that the allocation of the trampoline function occurs through a call
to `mmap` with the `PROT_READ | PROT_WRITE | PROT_EXEC` memory protection flags.

Therefore it should also be noted that the correct memory permissions should be
set for both the target function before modification as well as the trampoline
function, after allocation. Here is a snippet from the `cdl86` library for
setting memory attributes:

```
/* Set R/W memory protections for code page. */
int cdl_set_page_protect(uint8_t *code)
{
    int perms = 0x0;
    int ret = 0x0;

    /* Read, write and execute perms. */
    perms = PROT_EXEC | PROT_READ | PROT_WRITE;
    /* Calculate page size */
    uintptr_t page_size = sysconf(_SC_PAGE_SIZE);
    ret = mprotect(code - ((uintptr_t)(code) % page_size), page_size, perms);

    return ret;
}
```

The general procedure to place the `JMP` hook is as follows:

1. Determine the minimum number of bytes required for a `JMP` patch.
2. Create trampoline function.
3. Set memory permissions (read, write, execute).
4. Generate `JMP` to detour at target function.
5. Fill unused bytes with `NOP`.
6. Assign trampoline address to target function pointer.

Let's have a look at all of this in action using `GDB`. I will be using the
[basic_jmp.c](https://github.com/lunarbin/cdl86/blob/master/tests/basic_jmp.c)
test case in the `cdl86` library. The source code for this test case is shown
below:

```
#include "cdl.h"

typedef int add_t(int x, int y);
add_t *addo = NULL;

int add(int x, int y)
{
    printf("Inside original function\n");
    return x + y;
}

int add_detour(int x, int y)
{
    printf("Inside detour function\n");
    return addo(5,5);
}

int main()
{
    struct cdl_jmp_patch jmp_patch = {};
    addo = (add_t*)add;

    printf("Before attach: \n");
    printf("add(1,1) = %i\n\n", add(1,1));

    jmp_patch = cdl_jmp_attach((void**)&addo, add_detour);
    if(jmp_patch.active)
    {
        printf("After attach: \n");
        printf("add(1,1) = %i\n\n", add(1,1));
        printf("== DEBUG INFO ==\n");
        cdl_jmp_dbg(&jmp_patch);
    }

    cdl_jmp_detach(&jmp_patch);
    printf("\nAfter detach: \n");
    printf("add(1,1) = %i\n\n", add(1,1));

    return 0;
}
```

We compile the following source file with (modified from makefile):

```
gcc -I../ -g basic_jmp.c ../cdl.c ../lib/libudis86/*.c -g -o basic_jmp
```

Then load into `GDB` using:

```
gdb basic_jmp
```

Once `GDB` has loaded, we insert a breakpoints at lines `24` and `27` using the
command:

```
break 24
break 27
```

We start execution of the program with:

```
run
```

`GDB` will then inform you that the first breakpoint has been triggered. For this
first breakpoint we are interested in the `add()` function's assembly before the
hook has taken place. To inspect this assembly, provide:

```
disas /r add
```
```
Dump of assembler code for function add:
   0x0000555555561389 <+0>:	f3 0f 1e fa	endbr64
   0x000055555556138d <+4>:	55	push   %rbp
   0x000055555556138e <+5>:	48 89 e5	mov    %rsp,%rbp
   0x0000555555561391 <+8>:	48 83 ec 10	sub    $0x10,%rsp
   0x0000555555561395 <+12>:	89 7d fc	mov    %edi,-0x4(%rbp)
```

This is the disassembly of the unaltered target function. `12` bytes for the `JMP`
patch will have to be written at this address. Therefore the first `4`
instructions will need to be written to the trampoline function followed by a
`JMP` to address `0x0000555555561395` and that's all we need for the trampoline!

Now the fun part! Let's continue execution to the next breakpoint, where our
`JMP` hook will be placed.

```
continue
```

Let's examine the disassembly of our `add()` function once again:

```
Dump of assembler code for function add:
   0x0000555555561389 <+0>: 48 b8 b1 13 56 55 55 55 00 00 movabs $0x5555555613b1,%rax
   0x0000555555561393 <+10>: ff e0	jmpq   *%rax
   0x0000555555561395 <+12>: 89 7d fc	mov    %edi,-0x4(%rbp)
   0x0000555555561398 <+15>: 89 75 f8	mov    %esi,-0x8(%rbp)
```

`0x5555555613b1` is the address of our detour/intercept function. Let's examine
the disassembly of our detour function:

```
disas /r 0x5555555613b1
```

```
Dump of assembler code for function add_detour:
   0x00005555555613b1 <+0>:	f3 0f 1e fa	endbr64
   0x00005555555613b5 <+4>:	55	push   %rbp
   0x00005555555613b6 <+5>:	48 89 e5	mov    %rsp,%rbp
   0x00005555555613b9 <+8>:	48 83 ec 10	sub    $0x10,%rsp
   0x00005555555613bd <+12>:	89 7d fc	mov    %edi,-0x4(%rbp)
   0x00005555555613c0 <+15>:	89 75 f8	mov    %esi,-0x8(%rbp)
   0x00005555555613c3 <+18>:	48 8d 3d 53 5c 00 00	lea    0x5c53(%rip),%rdi
   0x00005555555613ca <+25>:	e8 b1 fd ff ff	callq  0x555555561180 <puts@plt>
   0x00005555555613cf <+30>:	48 8b 05 ba bc 01 00	mov    0x1bcba(%rip),%rax
   0x00005555555613d6 <+37>:	be 05 00 00 00	mov    $0x5,%esi
   0x00005555555613db <+42>:	bf 05 00 00 00	mov    $0x5,%edi
   0x00005555555613e0 <+47>:	ff d0	callq  *%rax
   0x00005555555613e2 <+49>:	c9	leaveq
   0x00005555555613e3 <+50>:	c3	retq
```

We can see that a call to our trampoline function is made to the address given
by referencing the `QWORD` (out function pointer) at address `0x55555557d090`,
let's deference it:

```
print /x *(long unsigned int*)(0x55555557d090)
```
```
$20 = 0x7ffff7ffb000
```

So the function pointer is pointing to address `0x7ffff7ffb000` which is our
trampoline function, let's dissasemble it:

```
x/10i 0x7ffff7ffb000
```

```
   0x7ffff7ffb000:	endbr64
   0x7ffff7ffb004:	push   %rbp
   0x7ffff7ffb005:	mov    %rsp,%rbp
   0x7ffff7ffb008:	sub    $0x10,%rsp
   0x7ffff7ffb00c:	movabs $0x555555561395,%rax
   0x7ffff7ffb016:	jmpq   *%rax
   0x7ffff7ffb018:	add    %al,(%rax)
   0x7ffff7ffb01a:	add    %al,(%rax)
   0x7ffff7ffb01c:	add    %al,(%rax)
   0x7ffff7ffb01e:	add    %al,(%rax)
```

You can see that our trampoline contains the first `4` instructions that were
replaced when the `JMP` patch was placed in our target function. You can see a
jmp back to address `0x555555561395` which was disassembled earlier. This should
give you an idea of how the control flow modification is achieved.

# INT3 Patching

There is another method of function detouring which involves placing `INT3`
breakpoints at the start of the target function in memory. `INT3` breakpoints
are encoded with the `0xCC` opcode:

```
/* Generate int3 instruction. */
uint8_t *cdl_gen_swbp(uint8_t *code)
{
    *(code + 0x0) = 0xCC;
    return code;
}
```

So rather than placing a `JMP` patch to the detour we simply write the byte
`0xCC` to the target function being careful to `NOP` the unused bytes. Once the
`RIP` register reaches an address of an `INT3` breakpoint the Linux kernel sends
a `SIGTRAP` signal to the process.

We can register our own signal handler but we need some additional info on the
signal such as context information. A context is the state of a program's
registers and stack. We need this info to compare the breakpoints `RIP` value to
any active global software breakpoints.

This is how the signal handler is registered in `cdl86`:

```
 struct sigaction sa = {};

    /* Initialise cdl signal handler. */
    if (!cdl_swbp_init)
    {
        /* Request signal context info which
         * is required for RIP register comparison.
         */
        sa.sa_flags = SA_SIGINFO | SA_ONESHOT;
        sa.sa_sigaction = (void *)cdl_swbp_handler;
        sigaction(SIGTRAP, &sa, NULL);
        cdl_swbp_init = true;
    }
    ...
```

Note the use of `SA_SIGINFO` to get context information. The software breakpoint
handler is then defined as follows:

```
void cdl_swbp_handler(int sig, siginfo_t *info, struct ucontext_t *context)
{
    int i = 0x0;
    bool active = false;
    uint8_t *bp_addr = NULL;

    /* RIP register point to instruction after the
     * int3 breakpoint so we subtract 0x1.
     */
    bp_addr = (uint8_t *)(context->uc_mcontext.gregs[REG_RIP] - 0x1);

    /* Iterate over all breakpoint structs. */
    for (i = 0; i < cdl_swbp_size; i++)
    {
        active = cdl_swbp_hk[i].active;
        /* Compare breakpoint addresses. */
        if (bp_addr == cdl_swbp_hk[i].bp_addr)
        {
            /* Update RIP and reset context. */
            context->uc_mcontext.gregs[REG_RIP] = (greg_t)cdl_swbp_hk[i].detour;
            setcontext(context);
        }
    }
}
```

Note that if a match of the `RIP` value to any known breakpoints occurs the `RIP`
value for the current context is updated and the new context applied using
`setcontext()`. A trampoline function similar to our `JMP` patch is allocated
and serves the same purpose.

# Code Injection

`cdl86` assumes that you are operating in the address space of the target
process. Therefore code injection is often required in practice and requires the
use of an
[injector](https://github.com/lunarbin/robocraft/tree/main/injector).

Once a shared library (`.so`) has been injected you can use the following code
to get the base address of the main executable module:

```
#include <link.h>
#include <inttypes.h>

int __attribute__((constructor)) init()
{
...
    struct link_map *lm = dlopen(0, RTLD_NOW);
    printf("base = %" PRIx64 , lm->l_addr);
...

}
```

Or find the address of a function by symbol name:

```
void* dl_handle = dlopen(NULL, RTLD_LAZY);
void* add_ptr = dlsym(dl_handle, "add");
```

# API
The API for the `cdl86` library is shown below:

```
struct cdl_jmp_patch cdl_jmp_attach(void **target, void *detour);
struct cdl_swbp_patch cdl_swbp_attach(void **target, void *detour);
void cdl_jmp_detach(struct cdl_jmp_patch *jmp_patch);
void cdl_swbp_detach(struct cdl_swbp_patch *swbp_patch);
void cdl_jmp_dbg(struct cdl_jmp_patch *jmp_patch);
void cdl_swbp_dbg(struct cdl_swbp_patch *swbp_patch);
```

# Source code
You can find the `cdl86` source code
[here](https://github.com/lunarjournal/cdl86).<br>

# Signature

```
+---------------------------------------+
|   .-.         .-.         .-.         |
|  /   \       /   \       /   \        |
| /     \     /     \     /     \     / |
|        \   /       \   /       \   /  |
|         "_"         "_"         "_"   |
|                                       |
|  _   _   _ _  _   _   ___   ___ _  _  |
| | | | | | | \| | /_\ | _ \ / __| || | |
| | |_| |_| | .` |/ _ \|   /_\__ \ __ | |
| |____\___/|_|\_/_/ \_\_|_(_)___/_||_| |
|                                       |
|                                       |
| Lunar RF Labs                         |
| https://lunar.sh                      |
|                                       |
| Research Laboratories                 |
| Copyright (C) 2022-2025               |
|                                       |
+---------------------------------------+
```

