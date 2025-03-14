---
layout: post
title: Tiny C Binaries
author: Dylan Müller
---

> By default, following the linking stage, `GCC` generates `ELF` binaries that contain
> redundant section data that increase executable size.

1. [ELF Binaries](#elf-binaries)
2. [Size Optimisation](#size-optimisation)
3. [Linux Syscalls](#linux-syscalls)
4. [Custom Linker Script](#custom-linker-script)
5. [GCC flags](#gcc-flags)
6. [SSTRIP](#sstrip)
7. [Source Code](#source-code)

# ELF Binaries

The standard file format for executable object code on Linux is `ELF` (Executable
and Linkable Format), it is the successor to the older `COFF` `UNIX` file format.

`ELF` Binaries consist of two sections, the `ELF` header and file data (object
code). The `ELF` header format for `64-bit` binaries is shown in the table below:

| Offset | Field                  | Description                            | Value                                                                                 |
|--------|------------------------|----------------------------------------|---------------------------------------------------------------------------------------|
| 0x00   | e_ident[EI_MAG0]       | magic number                           | 0x7F                                                                                  |
| 0x04   | e_ident[EI_CLASS]      | 32/64-bit                              | 0x2 = 64-bit                                                                          |
| 0x05   | e_ident[EI_DATA]       | endianness                             | 0x1 = little<br>0x2 = big                                                             |
| 0x06   | e_ident[EI_VERSION]    | elf version                            | 0x1 = original                                                                        |
| 0x07   | e_ident[EI_OSABI]      | system ABI                             | 0x00 = System V<br>0x02 = NetBSD<br>0x03 = Linux<br>0x09 = FreeBSD<br>                |
| 0x08   | e_ident[EI_ABIVERSION] | ABI Version                            | * ignored for static-linked binaries<br>* vendor specific for dynamic-linked binaries |
| 0x09   | e_ident[EI_PAD]        | undefined                              | * padded with zeros                                                                   |
| 0x10   | e_type                 | object type                            | 0x00 = ET_NONE<br>0x01 = ET_REL<br>0x02 = ET_EXEC<br>0x03 = ET_DYN<br>0x04 = ET_CORE  |
| 0x12   | e_machine              | system ISA                             | 0x3E = amd64<br>0xB7 = ARM (v8/64)                                                    |
| 0x14   | e_version              | elf version                            | 0x1 = original                                                                        |
| 0x18   | e_entry                | entry point                            | 64-bit entry point address                                                            |
| 0x20   | e_phoff                | header table offset                    | 64-bit program header table offset                                                    |
| 0x28   | e_shoff                | section table offset                   | 64-bit section header table offset                                                    |
| 0x30   | e_flags                | undefined                              | vendor specific or pad with zeros                                                     |
| 0x34   | e_ehsize               | elf header size                        | 0x40 = 64bits, 0x20 = 32bits                                                          |
| 0x36   | e_phentsize            | header table size                      | -                                                                                     |
| 0x38   | e_phnum                | #(num) entries in header table         | -                                                                                     |
| 0x3A   | e_shentsize            | section table size                     | -                                                                                     |
| 0x3C   | e_shnum                | #(num) entries in section table        | -                                                                                     |
| 0x3E   | e_shstrndx             | section names index into section table | -                                                                                     |
| 0x40   |                        |                                        | End of 64-bit ELF                                                                     |

These data fields are used by the Linux `PL` (program loader) to resolve the entry
point for code execution along with various fields such as the `ABI` version, `ISA`
type, as well as section listings.

A sample hello world program is shown below and was compiled with `GCC` using `gcc
main.c -o example`.

```
#include <stdio.h>

int main(int agrc, char *argv[]){
    printf("Hello, World!");
    return  0;
}
```

This produced an output executable of almost **~17 KB** ! If you've ever
programmed in assembly you might be surprised at the rather large file size for
such a simple program.

`GNU-binutils` `objdump` allows us to inspect the full list of `ELF` sections with
the `-h` flag.

After running `objdump -h example` on our sample binary we see that there are a
large number of `GCC` derived sections: `.gnu.version` and `.note.gnu.property`
attached to the binary image. The question becomes how much data these
additional sections are consuming and to what degree can we 'strip' out
redundant data.

![enter image description here](https://journal.lunar.sh/images/2/01.png)

`GNU-binutils` comes with a handy utility called `strip`, which attempts to remove
unused `ELF` sections from a binary. Running `strip -s example` results only in a
slightly reduced file of around **~14.5 KB**. Clearly, we need to strip much
more! :open_mouth:

# Size Optimisation

`GCC` contains a large number of optimisation flags, these include the common :
`-O2 -O3 -Os` flags as well as many more less widely used compile time options,
which we will explore further. However, since we have not yet compiled with any
optimisation thus far, and as a first step we recompile the above example with
`-Os`, to optimise for size.

![meme](https://journal.lunar.sh/images/memes/meme_00.png)

And we see no decrease in size! This is expected behaviour however, since the
`-Os` flag does not consider all redundant section data for removal, on the
contrary the additional section information placed by `GCC` in the output binary
is considered useful at this level of optimisation.

In addition, the use of `printf` binds object code from the standard library
into the final output executable and so we will instead call through to the
Linux kernel directly to print to the standard output stream.

# Linux syscalls

System calls on Linux are invoked with the `x86_64` `syscall` opcode and syscall
parameters follow a very specific order on `64-bit` architectures. For `x86_64`
([System V ABI  - Section
A.2.1](https://refspecs.linuxfoundation.org/elf/x86_64-abi-0.99.pdf)), the order
of parameters for linux system calls is as follows:

| description   | register (64-bit) |
|----------------|----------|
| syscall number | rax      |
| arg 1          | rdi      |
| arg 2          | rsi      |
| arg 3          | rdx      |
| arg 4          | r10      |
| arg 5          | r8       |
| arg 6          | r9       |


Arguments at user mode level (`__cdecl` calling convention), however, are parsed in
the following order:

| description | register (64-bit)    |
|-------------|-----|
| arg 1       | rdi |
| arg 2       | rsi |
| arg 3       | rdx |
| arg 4       | rcx |
| arg 5       | r8  |
| arg 6       | r9  |

To call through to the linux kernel from `C`, an assembly wrapper was required to
translate user mode arguments (`C` formal parameters) into kernel `syscall`
arguments:

```
syscall:
	mov rax,rdi
	mov rdi,rsi
	mov rsi,rdx
	mov rdx,rcx
	mov r10,r8
	mov r8,r9
	syscall
	ret
```

We may then make a call to this assembly routine from `C` using the following
function signature:

```
void* syscall(
	void* syscall_number,
	void* param1,
	void* param2,
	void* param3,
	void* param4,
	void* param5
);
```

To write to the standard output stream we invoke syscall `0x1`, which handles
file output. A useful `x86_64` Linux syscall table can be found
[here](https://blog.rchapman.org/posts/Linux_System_Call_Table_for_x86_64/).
Syscall `0x1` takes three arguments and has the following signature:

`sys_write( unsigned int fd, const char *buf, size_t count)`

A file called `base.c` was created, implementing both `syscall` and print wrappers:

```
// base.c
typedef  unsigned  long  int uintptr;
typedef  long  int intptr;

void* syscall(
	void* syscall_number,
	void* param1,
	void* param2,
	void* param3,
	void* param4,
	void* param5
);

static intptr print(void  const* data, uintptr nbytes)
{
	return (intptr)
		syscall(
		(void*)1, /* sys_write */
		(void*)(intptr)1, /* STD_OUT */
		(void*)data,
		(void*)nbytes,
		0,
		0
		);
}

int main(int agrc, char *argv[]){
	print("Hello, World", 12)
	return 0;
}
```

In order to instruct `GCC` to prevent linking in standard library object code, the
`-nostdlib` flag should be passed at compile time. There is one caveat however,
in that certain symbols, such as `_start` , which handle program startup and the
parsing of the command line arguments to `main` , will be left up to us to
implement, otherwise we will segfault :-/

However, this is quite trivial and luckily program initialisation is well
defined by -- [System V ABI - Section
3.4](https://refspecs.linuxfoundation.org/elf/x86_64-abi-0.99.pdf).

Initially it is specified that register `rsp` hold the argument count, while the
address given by `rsp+0x8` hold an array of `64-bit` pointers to the argument
strings.

From here the argument count and string pointer array index can be passed to
`rdi` and `rsi` respectively, the first two parameters of `main()` . Upon exit,
a call to syscall `0x3c` is then made to handle program termination gracefully.

Both the syscall and program startup assembly wrappers (written in GAS) were
placed in a file called `boot.s`:

```
/* boot.s */
.intel_syntax noprefix
.text
.globl _start, syscall

_start:
	xor rbp,rbp /* rbp = 0 */
	pop rdi /* rdi = argc, rsp= rsp + 8 */
	mov rsi,rsp /* rsi = char *ptr[] */
	and rsp,-16 /* align rsp to 16 bytes */
	call main
	mov rdi,rax /* rax = main return value */
	mov rax,60 /* syscall= 0x3c (exit) */
	syscall
	ret

syscall:
	mov rax,rdi
	mov rdi,rsi
	mov rsi,rdx
	mov rdx,rcx
	mov r10,r8
	mov r8,r9
	syscall
	ret
```

Finally gcc was invoked with `gcc base.c boot.s -nostdlib -o base`.

![enter image description here](https://journal.lunar.sh/images/2/05.png)

Wait what!? We still get a **~14 KB** executable after all that work? Yep, and
although we have optimised the main object code for our example, we have not yet
stripped out redundant `ELF` code sections which contribute a majority of the file
size.

# Custom Linker Script

Although it is possible to strip some redundant sections from an `ELF` binary
using `strip`, it is much more efficient to use a custom linker script.

A linker script specifies precisely which `ELF` sections to include in the output
binary, which means we can eliminate *almost* all redundancy. Care, however,
must be taken to ensure that essential segments such as `.text`, `.data`,
`.rodata*` are not discarded during linking to avoid a segmentation fault.

The linker script that I came up with is shown below (`x86_64.ld`):

```
OUTPUT_FORMAT("elf64-x86-64", "elf64-x86-64",
	      "elf64-x86-64")
OUTPUT_ARCH(i386:x86-64)
ENTRY(_start)

SECTIONS
{
    . = 0x400000 + SIZEOF_HEADERS;
    .text : { *(.text) *(.data*) *(.rodata*) *(.bss*) }
}
```

The linker script sets the virtual base address of the output binary to `0x400000`
and retains only the essential code segments.

Custom linker scripts are parsed to `GCC` with the `-T` switch and the resulting
binary was compiled with: `gcc -T x86_64.ld base.c boot.s -nostdlib -o base`.

This produced an output executable of around **~2.7 KB**.

This is much better, but there is still some room for improvement using
additional `GCC` compile time switches.

# GCC Flags

We have thus far managed to shrink our executable size down to **~2.7 KB** from our
initial file size of **~17 KB** by stripping redundant section data using a custom
linker script and removing standard library object code.

However, `GCC` has several compile time flags that can further help in removing
unwanted code sections, these include:

| flag                 | description                           |
|----------------------|---------------------------------------|
| -ffunction-sections  | place each function into own section  |
| -fdata-sections      | place each data item into own section |
| -Wl,\--gc-sections   | strip unused sections (linker)                 |
| -fno-unwind-tables   | remove unwind tables       |
| -Wl,\--build-id=none | remove build-id section               |
| -Qn                  | remove .ident directives              |
| -Os                  | optimize code for size                |
| -s                   | strip all sections                    |

Compiling our example again with: `gcc -T x86_64.ld base.c boot.s -nostdlib -o
base -ffunction-sections -fdata-sections -Wl,--gc-sections -fno-unwind-tables
-Wl,--build-id=none -Qn -Os -s`.

This produces an output executable with a size of **~1.5 KB** but we can still go
further!

Additionally, you can include the `-static` switch to ensure a static binary.
This results in an output executable of **~640 bytes**.

# SSTRIP

Despite all our optimisation thus far, there are still a few redundant code and
data sections in our dynamically linked output executable. Enter `sstrip`...

[sstrip](https://github.com/aunali1/super-strip) is a useful utility that
attempts to identify which sections of an `ELF` binary are to be loaded into
memory during program execution. Based off this, all unused code and data
sections are then subsequently removed. It is comparable to `strip` but performs
section removal more aggressively.

Running `./sstrip base` we get our final executable binary with a size of **~830
bytes** !

At this point it would probably be best to switch to assembly to get smaller
file sizes, however the goal of this `journal` was to create small executables
written in `C` and I think we've done quite well to reduce in size from **~17 KB**
down to **~830 bytes**!

![enter image description here](https://journal.lunar.sh/images/2/08.png)

As a final comment you might be wondering if we could have simply run `sstrip`
from our **17 KB** executable in the first place and the answer would be, no.

I tried doing this and ended up with a binary image of around **~12 KB** so it seems
the sstrip needs a bit of additional assistance in the form our our manual
optimisations to get really `tiny` binaries!

# Source Code

Source code used in this `journal` is available at:
[https://github.com/lunarjournal/tinybase](https://github.com/lunarbin/tinybase)

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
| Lunar Labs                            |
| https://lunar.sh                      |
|                                       |
| Research Laboratories                 |
| Copyright (C) 2022-2025               |
|                                       |
+---------------------------------------+
```

