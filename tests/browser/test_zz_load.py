import time, json
def test_load(make_page, argus):
    page = make_page(route="#/files")
    page.send("Emulation.setCPUThrottlingRate", {"rate": 6})
    page.send("Network.setCacheDisabled", {"cacheDisabled": True})
    sizes = {}
    def track(m):
        if m.get("method") == "Network.loadingFinished":
            sizes[m["params"]["requestId"]] = m["params"]["encodedDataLength"]
    page._listeners.append(track)
    t0 = time.time()
    page.reload()
    page.wait("!!document.querySelector('#nav') && !document.querySelector('#nav').hidden && document.querySelectorAll('.row').length > 3", timeout=60)
    t1 = time.time()
    nav = page.eval("JSON.stringify(performance.getEntriesByType('navigation').map(e => ({dcl: Math.round(e.domContentLoadedEventEnd), load: Math.round(e.loadEventEnd)})))")
    res = page.eval("JSON.stringify(performance.getEntriesByType('resource').map(r => [r.name.replace(location.origin, ''), Math.round(r.transferSize), Math.round(r.decodedBodySize), Math.round(r.duration)]))")
    res = json.loads(res)
    js = [r for r in res if r[0].split('?')[0].endswith('.js')]
    print("LOAD wall", round(t1 - t0, 2), "s", nav)
    print("LOAD requests", len(res), "js files", len(js), "js bytes", sum(r[2] for r in js), "total bytes", sum(r[2] for r in res))
    for r in sorted(res, key=lambda r: -r[2])[:15]:
        print("BIG", r)
    page.send("Profiler.enable"); page.send("Profiler.start")
    page.reload()
    page.wait("document.querySelectorAll('.row').length > 3", timeout=60)
    prof = page.send("Profiler.stop")["profile"]
    from collections import Counter
    nodes = {n["id"]: n for n in prof["nodes"]}
    dt = prof.get("timeDeltas", [])
    tot = Counter()
    for nid, d in zip(prof["samples"], dt):
        cf = nodes[nid]["callFrame"]
        tot[f'{cf["functionName"] or "(anon)"} {cf["url"].split("/")[-1]}:{cf["lineNumber"]}'] += d
    for k, v in tot.most_common(20):
        print("SELF", round(v / 1000), "ms", k)
