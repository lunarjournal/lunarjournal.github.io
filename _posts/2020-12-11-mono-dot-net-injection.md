---
layout: post
title: Mono/.NET Injection Under Linux
author: Dylan Müller
---

> Learning `mono` or `C#` library injection through a [Robocraft](https://robocraftgame.com/) exploit. The method used in
> this publication can be used to modify a wide range of Unity games.

1. [Mono Overview](#mono-overview)
2. [Exploiting Robocraft](#exploiting-robocraft)
3. [Source Code](#source-code)

# Mono Overview

[Mono](https://en.wikipedia.org/wiki/Mono_%28software%29) is an open source port
of the `.NET` framework which runs on a variety of operating systems (including
Linux).

The `mono` build chain compiles `C#` source code (`.cs` files) down to `IL` (immediate
language) spec'd byte code which is then executed by the `CLR` (Common Language
Runtime) layer provided by `mono`.

Due to the translation down to `IL`, module decompilation as well as
modification/reverse engineering is relatively straightforward and a variety of
`C#` `IL` decompilers/recompilers already exist
([dnSpy](https://github.com/dnSpy/dnSpy/),
[ILSpy](https://github.com/icsharpcode/ILSpy)).

The focus of this journal is on managed library injection, more specifically the
ability to inject `C#` code of our own and interact with/modify a target host.

# Exploiting Robocraft

[Robocraft](https://en.wikipedia.org/wiki/Robocraft) is an online `MMO` game
developed by `freejam` games. It features futuristic robotic battles and is an
example of an application we wish to tamper with.

![enter image description here](https://journal.lunar.sh/images/4/01.jpg)

`Robocraft` uses the [Unity3D](https://unity3d.com/get-unity/download) engine,
which is a high level `C#` component based game engine.

World entities in `Unity3D` derive from class `UnityEngine::GameObject` and may
have a number of components attached to them such as: rigidbodies, mesh
renderers, scripts, etc.

`UnityEngine::GameObject` has many useful
[properties](https://docs.unity3d.com/ScriptReference/GameObject.html) such as a
name (string), tag, transform (position), etc. as well as static methods for
finding objects by name, tag, etc. These methods become useful when injecting
our own code as they provide a facility for interfacing with the game engine
from an external context (our `C#` script).

Browsing the `Robocraft` root directory (installed via steam) revealed a few
directories that seemed interesting:

 - `Robocraft_Data`
 - `lib64`
 - `lib32`
 - `EasyAntiCheat`

![enter image description here](https://journal.lunar.sh/images/4/02.png)

Upon further inspection of the `Robocraft_Data` directory, we find the folders
containing the managed (`C#/mono`) portion of the application. In particular, the
Managed folder contains the `C#` libraries in `DLL` form of the `Unity3D` Engine as well
as other proprietary modules from the game developer.

![enter image description here](https://journal.lunar.sh/images/4/03.png)

However at his point it's worth noting the presence of the `EasyAntiCheat` folder
in the root game directory which confirms the presence of an `anti-cheat` client.

After some research I found out a few interesting details about the game's
`anti-cheat` client `EasyAntiCheat`:

 - The client computes hashes of all binary images during startup (including
   managed libraries) and is cross-referenced to prevent modification to game
   binaries.
 - Uses a heartbeat mechanism to ensure presence of the `anti-cheat` client (To
   mitigate `anti-cheat` removal).
 - Works with an online service known as `RoboShield` to monitor server side
   parameters such as position, velocity, damage, etc and assigns each user with
   a trust score. The lower the score the higher the chance of getting kicked
   from subsequent matches. This score seems to be persistent.

Nonetheless, nothing seemed to prevent us from injecting our own `C#` library at
runtime and this was the vector employed with `Robocraft`. The advantage of this
method was that no modification to the game binaries would be required and
therefore any client side anti-tamper protection could be bypassed.

In order to inject our own `C#` code we need to somehow force the client to load
our own `.NET/mono` library at runtime. This may be accomplished by a stager
payload which is essentially a shared library that makes internal calls to
`libmono.so`.

Some interesting symbols found in `libmono.so` include:

 - `mono_get_root_domain` - get handle to primary domain.
 - `mono_thread_attach` - attach to domain.
 - `mono_assembly_open` - load assembly.
 - `mono_assembly_get_image` - get assembly image.
 - `mono_class_from_name` - get handle to class.
 - `mono_class_get_method_from_name` - get handle to class method.
 - `mono_runtime_invoke` - invoke class method.

The function signatures for these symbols are shown below:

```
typedef void* (*mono_thread_attach)(void* domain);
typedef void* (*mono_get_root_domain)();
typedef void* (*mono_assembly_open)(char* file, void* stat);
typedef void* (*mono_assembly_get_image)(void* assembly);
typedef void* (*mono_class_from_name)(void* image, char* namespacee, char* name);
typedef void* (*mono_class_get_method_from_name)(void* classs, char* name, DWORD param_count);
typedef void* (*mono_runtime_invoke)(void* method, void* instance, void* *params, void* exc);
```

In order to perform code injection, firstly a handle to the root application
domain must be retrieved using `mono_get_root_domain`. The primary application
thread must then be binded to the root domain using `mono_thread_attach` and the
assembly image loaded with `mono_assembly_open` and `mono_assembly_get_image`.

Next the assembly class and class method to execute may be found by name using
`mono_class_from_name` and `mono_class_get_method_from_name`.

Finally the class method may be executed using `mono_runtime_invoke`. It should
be noted that the class method to execute should be declared as static.

The resulting stager payload is shown below:

```
#include <iostream>
#include <link.h>
#include <fstream>

using namespace std;

typedef unsigned long DWORD;

typedef void* (*mono_thread_attach)(void* domain);
typedef void* (*mono_get_root_domain)();
typedef void* (*mono_assembly_open)(char* file, void* stat);
typedef void* (*mono_assembly_get_image)(void* assembly);
typedef void* (*mono_class_from_name)(void* image, char* namespacee, char* name);
typedef void* (*mono_class_get_method_from_name)(void* classs, char* name, DWORD param_count);
typedef void* (*mono_runtime_invoke)(void* method, void* instance, void* *params, void* exc);


mono_get_root_domain do_mono_get_root_domain;
mono_assembly_open do_mono_assembly_open;
mono_assembly_get_image do_mono_assembly_get_image;
mono_class_from_name do_mono_class_from_name;
mono_class_get_method_from_name do_mono_class_get_method_from_name;
mono_runtime_invoke do_mono_runtime_invoke;
mono_thread_attach do_mono_thread_attach;

int __attribute__((constructor)) init()
{
        void* library = dlopen("./Robocraft_Data/Mono/x86_64/libmono.so",  RTLD_NOLOAD | RTLD_NOW);

        do_mono_thread_attach = (mono_thread_attach)(dlsym(library, "mono_thread_attach"));
        do_mono_get_root_domain = (mono_get_root_domain)(dlsym(library, "mono_get_root_domain"));
        do_mono_assembly_open = (mono_assembly_open)(dlsym(library, "mono_assembly_open"));
        do_mono_assembly_get_image = (mono_assembly_get_image)(dlsym(library, "mono_assembly_get_image"));
        do_mono_class_from_name = (mono_class_from_name)(dlsym(library, "mono_class_from_name"));
        do_mono_class_get_method_from_name = (mono_class_get_method_from_name)(dlsym(library, "mono_class_get_method_from_name"));
        do_mono_runtime_invoke = (mono_runtime_invoke)(dlsym(library, "mono_runtime_invoke"));


        do_mono_thread_attach(do_mono_get_root_domain());
        void* assembly = do_mono_assembly_open("./Robocraft_Data/Managed/Client.dll", NULL);

        void* Image = do_mono_assembly_get_image(assembly);
        void* MonoClass = do_mono_class_from_name(Image, "Test", "Test");
        void* MonoClassMethod = do_mono_class_get_method_from_name(MonoClass, "Load", 0);

        do_mono_runtime_invoke(MonoClassMethod, NULL, NULL, NULL);

    return 0;
}

void __attribute__((destructor)) shutdown()
{

};
```

The stager payload shown above loads the mono assembly located in
`<root>/Robocraft_Data/Managed/Client.dll` into memory and executes the class
method Load within the `namespace` `Test` and `class` `Test` (`Test::Test::Load`).

Load has the following signature: `public  static  void  Load()` The stager may
be compiled with: `gcc -fpic -shared stager.cpp -o stager.so`.

In order to inject the stager into the target process you may use any standard
Linux shared library
[injector](https://github.com/lunarbin/injector).

With the capability of loading our own `mono` code into the target process, we
need to ensure that our injected `C#` code stays persistent, i.e to prevent
de-allocation due to garbage collection.

For `Unity3D` this is typically achieved using the following pattern:

```
 public class Exploit : MonoBehaviour
	{...}

 public static class Test
    {
        private static GameObject loader;
        public static void Load()
        {
            loader = new GameObject();
            loader.AddComponent<Exploit>();
            UnityEngine.Object.DontDestroyOnLoad(loader);
        }
    }
```

It is also worth keeping track of the `mono/.NET` assembly versions used in the
original application. Ideally you would want to use an identical `.NET` version as
compiling your `C#` exploit with the wrong `.NET` version can cause your exploit to
fail.

For `Robocraft` `.NET` `v2.0` was required. Finding support for an older version of
`.NET` can be difficult as most modern `C#` `IDE's` do not support such an old target.
A simple solution to this problem is to download an older version of `mono`.

At this point the second stage payload (our `C#` exploit) can be developed. I
chose to implement three simple functionalities:

 - Increase/decrease game speed.

```
if(Input.GetKeyDown(KeyCode.F2)){
            speedhack =  !speedhack;
            if(speedhack == true){
                Time.timeScale = 3;
            }else{
                Time.timeScale = 1;
            }
        }
```

 - Clip through walls/obstacles.

```
if(Input.GetKeyDown(KeyCode.F3)){
            collision =  !collision;
            GameObject obj = GameObject.Find("Player Machine Root");
            Rigidbody rb = obj.GetComponent<Rigidbody>();
            if(collision == true){
                rb.detectCollisions = false;
            }else{
                rb.detectCollisions = true;
            }
        }
```

![enter image description here](https://journal.lunar.sh/images/4/05.png)
![enter image description here](https://journal.lunar.sh/images/4/06.png)

- Place all network entites near player.

```
if(Input.GetKeyDown(KeyCode.F1))
{
    salt = !salt;
    GameObject obj = GameObject.Find("Player Machine Root");
    position = obj.transform.position;

    foreach(GameObject gameObj in GameObject.FindObjectsOfType<GameObject>())
    {
        if(gameObj.name == "centerGameObject")
        {
            GameObject parent = gameObj.transform.parent.gameObject;
            if(parent.name != "Player Machine Root"){
                MonoBehaviour[] comp = parent.GetComponents<MonoBehaviour>();
                foreach (MonoBehaviour c in comp){
                    c.enabled = !salt;

                }
                Vector3 myposition = position;
                parent.transform.position = myposition;

            }

        }
    }
}
```

![enter image description here](https://journal.lunar.sh/images/4/07.png)

In order to find the names of the game objects for the main player as well as
network players you can simply iterate through all the global game objects and
dump the corresponding names to a text file.

# Source Code

All source code for this `journal` is hosted at
[https://github.com/lunarbin/robocraft](https://github.com/lunarbin/robocraft)

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

