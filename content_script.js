/*
  ====================
  content_script.js
  ====================
*/
if(!window.scrapbee_injected){
    ///////////////////////////////
    window.scrapbee_injected = true;
    var currDialog;
    var dlgDownload;
    ///////////////////////////////
    function stringifyArgs(args){
        var ar = Array.from(args); 
        ar.forEach(function(v, i){
            try{
                if(typeof v != "string")
    	            v = JSON.stringify(v);
            }catch(e){
                v = String(v);
            }
            ar[i] = v;
        });
        return ar.join(', ');
    }
    var log = {
        info: function(){
            log.sendLog("info", stringifyArgs(arguments));
        },
        error: function(){
            log.sendLog("error", stringifyArgs(arguments));
        },
        warning: function(){
            log.sendLog("warning", stringifyArgs(arguments));
        },
        debug: function(){
            // log.sendLog("debug", stringifyArgs(arguments))
        },
        clear: function(){
            browser.runtime.sendMessage({type:'CLEAR_LOG'});
        },
        sendLog: function(type, content){
            browser.runtime.sendMessage({type:'LOG', logtype: type, content});
        }
    };
    var oldLockListener;
    function lockListener(event){
        event.preventDefault();
        event.returnValue = '';
    }
    function lock(){
        if(!oldLockListener){
            window.addEventListener("beforeunload", lockListener);
            oldLockListener = lockListener;
            return true;
        } 
    }
    function unlock(){
        window.removeEventListener("beforeunload", oldLockListener);
        oldLockListener = null;
    }
    function truncate(fullStr, strLen, separator) {
        if (fullStr.length <= strLen) return fullStr;
        separator = separator || '...';
        var sepLen = separator.length,
            charsToShow = strLen - sepLen,
            frontChars = Math.ceil(charsToShow / 2),
            backChars = Math.floor(charsToShow / 2);
        return fullStr.substr(0, frontChars) + 
            separator + 
            fullStr.substr(fullStr.length - backChars);
    };
    function getLeavesIn(node) {
        var nodes = [];
        function getLeaves(node) {
            if (node.nodeType == 3) {
                nodes.push(node);
            } else {
                if(!node.hasChildNodes()){
                    nodes.push(node);
                }
                for (var i = 0, len = node.childNodes.length; i < len; ++i) {
                    getLeaves(node.childNodes[i]);
                }
            }
        }
        getLeaves(node);
        return nodes;
    }
    function cloneSegment(doc, isForSelection){
        return new Promise((resolve, reject) => {
            var content = null;
            var segment = new DocumentFragment();
            if(isForSelection){
                var selection = window.getSelection();
                if(selection.rangeCount == 0){
                    return reject("no selection activated");
                }
                for(var i=0;i<selection.rangeCount;i++){
                    var range = selection.getRangeAt(i);
                    var rangeContent = range.cloneContents();
                    var commonAncestor = range.commonAncestorContainer;
                    var leaves = getLeavesIn(rangeContent);
                    leaves.forEach(thisNode => {
                        if(thisNode.nodeType == 1){
                            var _uid = thisNode.getAttribute("scrapbee_unique_id");
                            var refNode = document.querySelector(`*[scrapbee_unique_id='${_uid}']`);
                        }else{
                            var refNode = thisNode;
                        }
                        for(var c=refNode,pr=null;c;){
                            var pn = c.cloneNode(false);
                            if(c.nodeType == 1){
                                var uid = c.getAttribute("scrapbee_unique_id");
                                var p = segment.querySelector(`*[scrapbee_unique_id='${uid}']`);
                                var exist = !!p;
                                if(!exist && c.tagName == "HTML"){
                                    segment.appendChild(pn);
                                    p = pn;
                                    exist = true;
                                }
                                if(pr){
                                    if(exist) // time to append to segment
                                        p.appendChild(pr);
                                    else  // as parent of previous node chain
                                        pn.appendChild(pr);
                                }
                                if(exist) break;
                            }
                            pr = pn;
                            if(c.parentNode == rangeContent) { // pure text node 
                                c = commonAncestor;
                            }else{
                                c = c.parentNode;
                            }
                        }
                    });
                }
                var html = segment.firstChild;
                if(html && html.tagName.toLowerCase() == "html"){
                    var heads = doc.getElementsByTagName("head");
                    if(heads.length){
                        html.insertBefore(heads[0].cloneNode(true), html.firstChild);
                    }
                }
            }else{
                segment.appendChild(doc.documentElement.cloneNode(true));
            }
            var __dlg = segment.querySelector(".scrapbee-dlg-container");
            if(__dlg) __dlg.remove();
            resolve(segment);
        });
    }
    /* capture content */
    async function gatherContent(isForSelection, name="index", path=""){
        var doc = document;
        var settings = await browser.runtime.sendMessage({type:'GET_SETTINGS'});
        // injext all frames
        if(settings.saving_save_frames == "on"){
            await browser.runtime.sendMessage({type: "GET_IFRAMES"}).then(async function(ar){
                for(var i=0;i<ar.length;i++){
                    var f = ar[i];
                    doc.querySelectorAll("iframe,frame").forEach((iframe, i) => {
                        if(f.url == iframe.src){
                            iframe.setAttribute("scrapbee_frame_id", f.frameId);
                        }
                    });
                    try{
                        await browser.runtime.sendMessage({type: "INJECT_IFRAME", frameId: f.frameId});
                    }catch(e){
                        console.log("invalid url: ", f.url) // about:debugging, about:addons causes an error
                    }
                }
            });
        }
        return new Promise(async (resolve, reject) => {
            /** html */
            var content = null;
            
            /** set unique id */
            document.querySelectorAll("*").forEach(el => {
                el.setAttribute("scrapbee_unique_id", "el" + new NumberRange(0,999999999).random());
            });
            try{
                var segment = await cloneSegment(doc, isForSelection)
            }catch(e){
                reject(e)
            }
            
            /** css */
            var css = [];
            function getRuleCss(r){
                var css = [];
                if(r instanceof CSSStyleRule){
                    css.push(r.cssText);
                }else if(r instanceof CSSImportRule){
                    rule = r.styleSheet.cssRules;
                    for (let r of rule){
                        css.push(r.cssText + "");
                    }
                }
                return css.join("\n");
            }
            for(let sheet of doc.styleSheets){
                try{
                    var rule = sheet.rules || sheet.cssRules;
                    for (let r of rule){
                        css.push(getRuleCss(r));
                    }
                }catch(e){
                    if(e.name == "SecurityError") {
                        try{
                            var request = new XMLHttpRequest();
                            request.open('GET', sheet.href, false);  // `false` makes the request synchronous
                            request.send(null);
                            if (request.status === 200) {
                                css.push(request.responseText);
                            }
                        }catch(e){
                            log.error(`error process css ${sheet.href}: ${e.message}`);
                        }
                    }
                }
            }
            
            /** gather resources and inline styles */
            var distinct = {};
            var RESULT = [];
            var haveIcon = false;
            segment.childNodes.iterateAll(function(item){
                if(item.nodeType == 1){
                    var el = new ScrapbeeElement(item)
                    var resources = el.processResources();
                    // el.processInlineStyle();
                    for(let r of resources){
                        if(!distinct[r.url]){
                            distinct[r.url] = 1;
                            RESULT.push(r);
                            if(r.saveas == "favicon.ico"){
                                haveIcon = true;
                            }
                            r.path = path;
                        }
                    }
                }
            });
            /*** fav icon */
            var icon_url = await browser.runtime.sendMessage({type: "GET_TAB_FAVICON"});
            if(icon_url && !RESULT.find(item => {return item.type == "image" && item.saveas == `favicon.ico`;})){
                RESULT.push({type: "image", url: location.origin + "/favicon.ico", saveas: `favicon.ico`, path});
                haveIcon = true;
            }
            /*** add main css tag */
            var mc = doc.createElement("link");
            mc.rel="stylesheet";
            mc.href=`index.css`;
            mc.media="screen";
            var head = segment.querySelectorAll("head");
            if(head.length){
                head[0].appendChild(mc);
            }
            /*** remove tags not wanted */
            segment.querySelectorAll("*[mark_remove='1']").forEach(el => el.remove());
            /*** frames */
            if(settings.saving_save_frames == "on"){
                var frames = segment.querySelectorAll("iframe, frame");
                for(var i=0;i<frames.length;i++){
                    var iframe = frames[i];
                    var frameId = parseInt(iframe.getAttribute("scrapbee_frame_id"));
                    try{
                        var name = "iframe" + (i + 1);
                        var [_res, a, b] = await browser.runtime.sendMessage({
                            type: "CALL_IFRAME",
                            action:"GATHER_CONTENT",
                            path: path + name + "/",
                            name: name,
                            saveType: "SAVE_PAGE", // isForSelection ? "SAVE_SELECTION" : "SAVE_PAGE",
                            frameId: frameId
                        });
                        RESULT = RESULT.concat(_res);
                        iframe.setAttribute("src", name + "/index.html");
                    }catch(e){
                        // consele.log(e) // can not log?
                    }
                }
            }
            /*** html page and css */
            RESULT.push({type: "text", mime:"text/css", saveas: `${path}index.css`, content: css.join("\n")});
            RESULT.push({type: "text", mime:"text/html", url: doc.location.href, saveas: `${path}index.html`, content: segment.html().trim()});
            /** remove unique id */
            document.querySelectorAll("*").forEach(el => {
                el.removeAttribute("scrapbee_unique_id");
            });       
            resolve([RESULT, doc.title, haveIcon]);
        });
    };
    function startBookmark(rdf, rdfPath, itemId){
        browser.runtime.sendMessage({type: "GET_TAB_FAVICON"}).then((url) => {
            // if(icon.match(/^data:image/i)) // base64
            var filename = `${rdfPath}/data/${itemId}/favicon.ico`;
            browser.runtime.sendMessage({type: "DOWNLOAD_FILE", url, filename, itemId}).then(() => {
                // var icon = "resource://scrapbook/data/" + itemId + "/favicon.ico";
                browser.runtime.sendMessage({type:'UPDATE_FINISHED_NODE', haveIcon: !!url, rdf, itemId});
                // todo: showNotification({message: `Capture url "${document.title}" done`, title: "Info"});
            });
        });
    }
    async function startCapture(saveType, rdf, rdfPath, itemId, autoClose=false){
        if(!lock()) return;
        dlgDownload = new DialogDownloadTable('Download', 'Waiting...', async function(){
            var settings = await browser.runtime.sendMessage({type:'GET_SETTINGS'});
            var res = [];
            // toplevel page
            autoClose = settings.auto_close_saving_dialog == "on" || autoClose;
            dlgDownload.hideButton()
            dlgDownload.addHeader("type", "source", "destination", "status");
            dlgDownload.hint = "Gathering resources...";            
            dlgDownload.show();
            try{
                var [r, title, haveIcon] = await gatherContent(saveType == "SAVE_SELECTION");
            }catch(e){
                browser.runtime.sendMessage({type:'REMOVE_FAILED_NODE', haveIcon, rdf, itemId});
                dlgDownload.remove();
                unlock();
                return alert(e);
            }
            res = res.concat(r);
            dlgDownload.hint = "Downloading...";
            var blobfile = {};
            function download(){
                return new Promise((resolve, reject)=>{
                    var downloaded = 0;
                    res.forEach(function(r, i){
                        var style = "cursor:pointer;color:#fff;background:#555;display:inlie-block;border-radius:3px;padding:3px";
                        var sourceLink = r.url ? "<a href='" + r.url + "' target='_blank' style='color:#05f'>" + truncate(r.url, 32) + "</a>" : "generated";
                        if(r.type == "image"){
                            dlgDownload.addRow("", sourceLink, "",
                                               `<font style='color:#cc5500'>downloading.. </font> <span style='${style}'>ignore</span>`);
                            var span = dlgDownload.getCell(i, 3).querySelector("span");
                            span.onclick = function(e){ // ignore this resource (cancel downloading)
                                downloaded ++;
                                dlgDownload.updateCell(i, 3, "<font style='color:#ff0000'>canceled</font>");
                                r.failed = 1;
                                if(downloaded == res.length){
                                    resolve();
                                }
                            };
                            downloadFile(r.url, function(b){
                                var ext = getMainMimeExt(b.type) || "";
                                r.filename = r.path + (r.saveas || (r.hex + ext));
                                blobfile[r.hex] = (r.saveas || (r.hex + ext));
                                if(b){
                                    r.blob = b;
                                    dlgDownload.updateCell(i, 0, b.type);
                                    if(b.type)
                                        dlgDownload.updateCell(i, 3, "<font style='color:#005500'>buffered</font>");
                                }else{
                                    if(r.saveas == "favicon.ico")
                                        haveIcon = false;
                                    dlgDownload.updateCell(i, 3, "<font style='color:#ff0000'>failed</font>");
                                    r.failed = 1;
                                }
                                downloaded ++;
                                dlgDownload.updateCell(i, 2, r.filename);
                                if(downloaded == res.length){
                                    resolve();
                                }
                            });
                        }else{
                            r.filename = r.saveas;
                            dlgDownload.addRow(r.mime, sourceLink, r.filename, "<font style='color:#005500'>buffered</font>");
                            downloaded++;
                            if(downloaded == res.length){
                                resolve();
                            }                                
                        }
                    });
                });
            }
            await download();
            dlgDownload.hint = "Saving data...";

            function save(){
                return new Promise((resolve, reject)=>{
                    var saved = 0;
                    function inc(){
                        if(++saved == res.length)
                            resolve();
                    }
                    res.forEach(function(item, i){
                        if(item.failed){
                            inc();
                        }else if(item.blob){
                            item.path = `${rdfPath}/data/${itemId}/${item.filename}`;
                            browser.runtime.sendMessage({type: 'SAVE_BLOB_ITEM', item}).then((response) => {
                                dlgDownload.updateCell(i, 3, "<font style='color:#0055ff'>saved</font>");
                                inc();
                            }).catch(e => {
                                dlgDownload.updateCell(i, 3, "<font style='color:#ff0000'>failed</font>");
                                log.error(e.message);
                                inc();
                            });
                        }else{
                            var path = `${rdfPath}/data/${itemId}/${item.filename}`;
                            var content = item.content;
                            for(hex in blobfile){
                                var reg = new RegExp(hex, "g" );
                                if(hex) content = content.replace(reg, blobfile[hex]);
                            }                            
                            if(item.mime == "text/html"){
                                var node = document.doctype;
                                if(node){
                                    var doctype = "<!DOCTYPE "
                                        + node.name
                                        + (node.publicId ? ' PUBLIC "' + node.publicId + '"' : '')
                                        + (!node.publicId && node.systemId ? ' SYSTEM' : '') 
                                        + (node.systemId ? ' "' + node.systemId + '"' : '')
                                        + '>';
                                    content = [doctype, content].join("\n");
                                }else{
                                    content = ['<!Doctype html>', content,].join("\n");
                                }
                            }
                            browser.runtime.sendMessage({type: 'SAVE_TEXT_FILE', text: content, path}).then((response) => {
                                dlgDownload.updateCell(i, 3, "<font style='color:#0055ff'>saved</font>");
                                inc();
                            }).catch(e=>{
                                dlgDownload.updateCell(i, 3, "<font style='color:#ff0000'>failed</font>");
                                log.error(e.message);
                                inc();
                            });
                        }
                    });
                })
            };
            await save();
            dlgDownload.hint = "All done";
            dlgDownload.showButton();
            browser.runtime.sendMessage({type:'UPDATE_FINISHED_NODE', haveIcon, rdf, itemId});
            if(autoClose){
                unlock();
                dlgDownload.remove();
            }
        }, function(r){ // click ok
            unlock();
            dlgDownload.remove();
        });
    }
    browser.runtime.onMessage.addListener(function (request, sender, sendResponse) {
        log.debug("content script recv msg:", request.type)
        if(request.type == "SAVE_ADVANCE_REQUEST"){
            if(oldLockListener)
                reject(Error("a task already exists on this page"));
            if(lock()){   
                return new Promise((resolve, reject) => {
                    var url =  browser.extension.getURL("advcap.html");
                    var w = new DialogIframe("{CAPTURE}".translate(), url, function(){
                        browser.runtime.sendMessage({type:'TAB_INNER_CALL',
                                                     dest: "CAPTURER_DLG",
                                                     action: "INIT_FORM",
                                                     title: document.title,
                                                     url: location.href}).then(function(){});
                        resolve();
                    });
                    currDialog = w;
                    w.show();
                });
            }
        }else if(request.type == "GATHER_CONTENT") {
            return gatherContent(request.saveType == "SAVE_SELECTION", request.name, request.path);
        }else if(request.type == 'SAVE_PAGE_REQUEST' || request.type == 'SAVE_SELECTION_REQUEST'){
            if(oldLockListener)
                reject(Error("a task already exists on this page"));
            browser.runtime.sendMessage({type: "CREATE_NODE_REQUEST", nodeType: "page", title: document.title, url: location.href}).then((r) => {
                startCapture(request.type.replace(/_REQUEST/, ""), r.rdf, r.rdfPath, r.itemId, request.autoClose);
            }).catch(function (error) {
                alert("capture failed: " + error)
            });
        }else if(request.type == 'SAVE_URL_REQUEST'){
            browser.runtime.sendMessage({type: "CREATE_NODE_REQUEST", nodeType: "bookmark", title: document.title, url: location.href}).then((r) => {
                startBookmark(r.rdf, r.rdfPath, r.itemId);
            });
        }else if(request.type == "TAB_INNER_CALL" && request.dest == "CONTENT_PAGE"){
            if(request.action == "CANCEL_CAPTURE"){
                currDialog.remove();
                unlock();
            }else if(request.action == "START_CAPTURE"){
                currDialog.remove();
                unlock();
                browser.runtime.sendMessage({type: "IS_SIDEBAR_OPENED"}).then(isSidebarOpened => { // check sidebar of current window
                    if(isSidebarOpened){
                        /** send to all window ??? */
                        var request_new = request;
                        request_new.type = 'CREATE_MIRROR_NODE';
                        request_new.ico = "";
                        browser.runtime.sendMessage(request_new);
                    }
                    if(request.saveType == "SAVE_URL"){
                        startBookmark(request.rdf, request.rdfPath, request.itemId);
                    }else{
                        startCapture(request.saveType, request.rdf, request.rdfPath, request.itemId);
                    }
                });
            }
        }
        return false;
    });
    function isDescendant(parent, child) {
        var node = child;
        while (node != null) {
            if (node == parent) {
                return true;
            }
            node = node.parentNode;
        }
        return false;
    }
    function downloadFile(url, callback){
        try{
            var oReq = new XMLHttpRequest();
            oReq.open("GET", url, true);
            oReq.responseType = "blob";
            oReq.onload = function(oEvent) {
                if(oReq.response){
                    callback(oReq.response);
                }else{
                    callback(false);
                }
            };
            oReq.onerror = function(e){
                callback(false);
            };
            oReq.send();
        }catch(e){
            log.error(`download file error, ${e}`);
            callback(false);
        }
    }
    function loadCss(id, href){
        $(`*[id='${id}']`).remove();
        var head  = document.getElementsByTagName('head')[0];
        var link  = document.createElement('link');
        link.id = id;
        link.rel  = 'stylesheet';
        link.type = 'text/css';
        link.href = href;
        link.media = 'all';
        head.appendChild(link);
    }
    var extension_id = browser.i18n.getMessage("@@extension_id");
    loadCss("content_script", `moz-extension://${extension_id}/content_script.css`);
    loadCss("content_script", `moz-extension://${extension_id}/dialog.css`);
}
console.log("[content_script.js] loaded");
