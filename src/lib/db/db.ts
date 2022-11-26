import { USE_MEMORY_CACHE } from "../constants"
import eventListener from "../eventListener"
import memoryCache from "../memoryCache"
import { normalStore, metadataStore, thumbnailStore } from "../localForage/localForage"

const indexKey = "@internal:index"
const USE_INTERNAL_INDEX = false

export type StoreTypes = "normal" | "thumbnails" | "metadata"

const getStore = (type: StoreTypes): LocalForage => {
    if(type == "thumbnails"){
        return thumbnailStore
    }
    else if(type == "metadata"){
        return metadataStore
    }

    return normalStore
}

const updateIndex = (key: string, type: "add" | "remove", storeType: StoreTypes = "normal"): Promise<boolean> => {
    if(!USE_INTERNAL_INDEX){
        return Promise.resolve(true)
    }

    return new Promise((resolve, reject) => {
        get(indexKey, storeType, false).then((value: any) => {
            if(typeof value == "undefined"){
                value = {}
            }
            
            if(value == null){
                value = {}
            }

            if(type == "add"){
                value[key] = key
            }
            else{
                delete value[key]
            }

            set(indexKey, value, storeType, false).then(() => {
                return resolve(true)
            }).catch(reject)
        }).catch(reject)
    })
}

export const warmUpDb = async () => {
    if(process.env.NODE_ENV == "development"){
        console.time("warmUpDb")
    }

    const normalKeys = await keys("normal")
    const metadataKeys = await keys("metadata")

    for(let i = 0; i < normalKeys.length; i++){
        await get(normalKeys[i].toString(), "normal")
    }

    for(let i = 0; i < metadataKeys.length; i++){
        await get(metadataKeys[i].toString(), "normal")
    }

    if(process.env.NODE_ENV == "development"){
        console.timeEnd("warmUpDb")
    }
}

export const get = (key: string, storeType: StoreTypes = "normal", index: boolean = false): Promise<any> => {
    return new Promise((resolve, reject) => {
        if(USE_MEMORY_CACHE){
            if(memoryCache.has("db:" + storeType + ":" + key)){
                return resolve(memoryCache.get("db:" + storeType + ":" + key))
            }
        }

        getStore(storeType).getItem(key).then((value: any) => {
            if(typeof value == "undefined"){
                value = null
            }
            
            if(value !== null && USE_MEMORY_CACHE && storeType !== "thumbnails"){
                memoryCache.set("db:" + storeType + ":" + key, value)
            }

            if(value !== null && index){
                updateIndex(key, "add", storeType).then(() => {
                    return resolve(value)
                }).catch(reject)
            }
            else{
                return resolve(value)
            }
        }).catch(reject)
    })
}

export const set = (key: string, value: any, storeType: StoreTypes = "normal", index: boolean = true): Promise<boolean> => {
    return new Promise((resolve, reject) => {
        getStore(storeType).setItem(key, value).then(() => {
            if(USE_MEMORY_CACHE){
                memoryCache.set("db:" + storeType + ":" + key, value)
            }

            if(!index){
                eventListener.emit("dbSet", {
                    key,
                    value
                })

                return resolve(true)
            }
            
            updateIndex(key, "add", storeType).then(() => {
                eventListener.emit("dbSet", {
                    key,
                    value
                })

                return resolve(true)
            }).catch(reject)
        }).catch(reject)
    })
}

export const remove = (key: string, storeType: StoreTypes = "normal"): Promise<boolean> => {
    return new Promise((resolve, reject) => {
        getStore(storeType).removeItem(key).then(() => {
            if(USE_MEMORY_CACHE){
                memoryCache.remove("db:" + storeType + ":" + key)
                memoryCache.remove("db:" + storeType + ":keys:allKeys")
            }

            updateIndex(key, "remove", storeType).then(() => {
                eventListener.emit("dbRemove", {
                    key
                })
    
                return resolve(true)
            }).catch(reject)
        }).catch(reject)
    })
}

export const clear = (storeType: StoreTypes = "normal"): Promise<boolean> => {
    return new Promise((resolve, reject) => {
        getStore(storeType).clear().then(() => {
            if(USE_MEMORY_CACHE){
                memoryCache.remove("db:" + storeType + ":keys:allKeys")

                memoryCache.cache.forEach((_, key: string) => {
                    if(key.indexOf("db:" + storeType) !== -1){
                        memoryCache.remove(key)
                    }
                })
            }

            eventListener.emit("dbClear")

            return resolve(true)
        }).catch(reject)
    })
}

export const keys = (storeType: StoreTypes = "normal"): Promise<string[]> => {
    return new Promise((resolve, reject) => {
        getStore(storeType).keys().then(resolve).catch(reject)
    })
}

export default {
    get,
    set,
    remove,
    clear,
    keys,
    warmUpDb
}