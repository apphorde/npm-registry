# npm-registry

Minimal implementation of NPM registry format to use web components or ES modules via NPM

## Motivation

Modern applications are composed of many small components and libraries.
It's more hassle to publish tiny packages to NPM than just maintaining them as single files.
But as soon as you need one item in another app, a registry becomes important.

This repository implements a minimal NPM-compatible, read-only, HTTP server to turn single files into NPM packages

## Requirements

The registry contents must follow a few rules:

- every module has a scope, like `@foo`
- every package follows semantic versioning format. Only `x.y.z` versions are allowed, for simplicity.
- every module has a single entry file, and is an ESM module

## Usage

To install from the registry, NPM need a `.npmrc` configuration to tell where to search for a given scope.

For example, if the registry runs at `https://npm.example.com` and we want the package `@foo/bar`, here's the `.npmrc`

```
@foo:registry=https://npm.example.com
```

With that, `npm` will look for a manifest JSON at `https://npm.example.com/@foo%2fbar`.
The manifest will tell NPM where to download a version of `@foo/bar` from a tarball (tgz) file.

## Environment variables

`CACHE_PATH` defines where the tarballs will be stored. `.tgz` files will be generated automatically upon their first request.
`DATA_PATH` must be also defined in the environment, to tell where the registry modules are stored.

## Folder structure

Starting from `DATA_PATH`, in this example as `/data`, here's the expected folder structure:

```text
/data
    /@foo
        /module-one
            1.0.0.mjs
            1.1.0.mjs

        /module-two
            0.1.0.mjs

    /@bar
        /bar-one
            1.0.0.mjs
```
