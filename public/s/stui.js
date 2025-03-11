class STUI extends STBase {
    #lastPeerReport = null;

    constructor() {
        super();

        this.loggedInState = van.state(false);
        this.displayNameState = van.state("Anonymous");
    }

    get video() {
        return document.getElementById('main_video');
    }

    updateUserState(user) {
        this.loggedInState.val = user && !user.isAnonymous;
        this.displayNameState.val = this.loggedInState.val ?
            user.displayName :
            "Anonymous";
    }

    setup() {
        this.setupView();
        this.updateUserState(firebase.auth().currentUser);
        firebase.auth().onAuthStateChanged((user) => { this.updateUserState(user); });

        if (this.view == "embed") {
            this.setupEmbedView();
        }
        else {
            let lo = this.computeLayout();
            this.setupVideoWindow(lo);
            this.setupInfoWindow(lo);
        }
    }

    setupView() {
        var url = new URL(window.location.href);
        this.view = url.searchParams.get("view") || "full";
    }

    computeLayout() {
        var lo = {};

        lo.titleHeight = 39;
        lo.buffer = 5;
        lo.width = window.innerWidth - lo.buffer;
        lo.height = window.innerHeight - lo.buffer;
        lo.videoX = lo.buffer;
        lo.videoY = lo.buffer;
        lo.videoWidth = lo.width * 0.666 - lo.buffer * 2;
        lo.videoHeight = lo.videoWidth / 1.777 + lo.titleHeight;
        lo.chatX = lo.videoX + lo.videoWidth + lo.buffer;
        lo.chatY = lo.videoY;
        lo.chatWidth = lo.width * 0.333 - lo.buffer;
        lo.chatHeight = lo.videoHeight;

        return lo;
    }

    setupVideoWindow(lo) {
        const { div, span, video } = van.tags;

        van.add(document.body, FloatingWindow(
            {
                title: "StreamTooth Development Stream",
                closed, x: lo.videoX, y: lo.videoY, width: lo.videoWidth, height: lo.videoHeight,
                childrenContainerStyleOverrides: { padding: 0 },
                headerColor: "white"
            },
            div(
                span({
                    class: "vanui-window-cross",
                    style: "position: absolute; top: 8px; right: 8px;cursor: pointer;",
                    onclick: () => closed.val = true,
                }, "×"),
                video({ id: "main_video", controls: "controls", autoplay: "autoplay", muted: "muted" })
            )
        ));
    }

    setupEmbedView() {
        const { div, video } = van.tags;

        van.add(document.body, div({ style: "width:100%;height:100%" },
            video({ id: "main_video", controls: "controls", autoplay: "autoplay", muted: "muted" })
        ));
    }

    createPeersTab() {
        const { div, button } = van.tags;

        return div(
            div({ id: "peers" }),
            div({ class: "bottom" },
                button({ class: "app", onclick: () => { streamtooth.disconnect(); } }, "Disconnect"),
                button({ class: "app", onclick: () => { streamtooth.stop(); } }, "Stop")
            )
        );
    }

    createChatTab(lo) {
        const { div, input } = van.tags;

        return div({ id: "chat" },
            div({ id: "chat_messages" }),
            input({
                id: "chat_input",
                style: `width:${lo.chatWidth - 25}px`,
                onkeydown: (ev) => {
                    if (ev.key == "Enter") {
                        var text = ev.target.value;
                        ev.target.value = "";

                        this.sendChatOutbound(text);
                    }
                }
            })
        )
    }

    createAboutTab() {
        const { p } = van.tags;

        return p("The stream information will go here.")
    }

    createProfileTab() {
        const { div, h3, input, button, p } = van.tags;

        return div({ id: "profile" },
            () => {
                if (this.loggedInState.val) {
                    return div(
                        h3(`Welcome back ${this.displayNameState.val}`),
                        button({
                            class: 'app', onclick: () => {
                                firebase.auth().signOut();
                            }
                        }, "Sign Out")
                    );
                }
                else {
                    return div(
                        h3("Sign In"),
                        input({ id: 'siEmail', placeholder: 'E-mail address' }),
                        input({ id: 'siPassword', type: 'password', placeholder: 'Password' }),
                        p({ id: 'siError', class: 'error' }, "Error"),
                        button({ class: 'app', onclick: () => { this.handleSignIn() } }, "Sign In"),
                        h3("Sign Up"),
                        input({ id: 'suEmail', placeholder: 'E-mail address' }),
                        input({ id: 'suDisplayName', placeholder: 'Display name' }),
                        input({ id: 'suPassword', type: 'password', placeholder: 'Password' }),
                        input({ id: 'suRepeat', placeholder: 'Repeat password', type: 'password' }),
                        p({ id: 'suError', class: 'error' }, "Error"),
                        button({ class: 'app', onclick: () => { this.handleSignUp() } }, "Sign Up")
                    );
                }
            }
        );
    }

    setupInfoWindow(lo) {
        const { div, span, input, p, button, h3 } = van.tags;

        var tabs = {
            'Peers': this.createPeersTab(),
            'Chat': this.createChatTab(lo),
            'About': this.createAboutTab(),
            'Profile': this.createProfileTab()
        };

        van.add(document.body, FloatingWindow(
            {
                closed, x: lo.chatX, y: lo.chatY, width: lo.chatWidth, height: lo.chatHeight,
                childrenContainerStyleOverrides: { padding: 0 },
            },
            div(
                span({
                    class: "vanui-window-cross",
                    style: "position: absolute; top: 8px; right: 8px;cursor: pointer;",
                    onclick: () => closed.val = true,
                }, "×"),
                Tabs(
                    {
                        style: "width: 100%;",
                        tabButtonActiveColor: "white",
                        tabButtonBorderStyle: "none",
                        tabButtonRowColor: "lightblue",
                        tabButtonRowStyleOverrides: { height: "2.5rem" },
                        tabButtonStyleOverrides: { height: "100%" },
                        resultClass: "infoTabs"
                    },
                    tabs
                )
            )
        ));

        var profileTabElement = document.querySelectorAll('.infoTabs .vanui-tab-button')[3];
        van.derive(() =>
            profileTabElement.innerText = this.loggedInState.val ?
                this.displayNameState.val :
                "Sign In"
        );
    }

    getPeerHtml(peerReport) {
        var html = "<div>";

        if (peerReport.remotePeerId) {
            html += peerReport.remotePeerId;
        }
        else {
            html += "[No peerId]";
        }

        html += " [" + peerReport.type + ":" + peerReport.context + "] - ";

        if (peerReport.state == "connected" && peerReport.fps) {
            html += peerReport.width + "x" + peerReport.height + "@" + peerReport.fps
        }
        else {
            html += peerReport.state;
        }

        if (peerReport.offerMessage) {
            html += ` <a href="javascript:showOffer(${peerReport.connectionId})">offer</a>`
        }

        if (peerReport.answerMessage) {
            html += ` <a href="javascript:showAnswer(${peerReport.connectionId})">answer</a>`
        }

        html += "</div>";

        return html;
    }

    updatePeers(report) {
        var peersEle = document.getElementById('peers');
        // Peers tab does not appear in embedded view
        if (!peersEle) return;

        var html = "<h3>Peer ID: " + report.peerId + "</h3>";

        html += "<h3>Peers</h3>";

        for (var peer of report.peers) {
            html += this.getPeerHtml(peer);
        }

        peersEle.innerHTML = html;
    }

    sendChatOutbound(text) {
        this.dispatchEvent(new CustomEvent("message", { "detail": text }));
    }

    addChatMessage(msg) {
        var el = document.getElementById('chat_messages');
        // Chat tab does not appear in embedded view
        if (!el) return;

        // TODO FIXME Cross domain scripting issue
        el.innerHTML += `<div><span>${msg.displayName}:</span> ${msg.text}</div>`;
    }

    handleStatus(ev) {
        this.#lastPeerReport = ev.detail;
        this.updatePeers(ev.detail);
    }

    handleChatInbound(ev) {
        this.addChatMessage(ev.detail);
    }

    getPeerReport(connectionId) {
        var report = this.#lastPeerReport;
        for (var peer of report.peers) {
            if (peer.connectionId == connectionId) {
                return peer;
            }
        }
    }

    showOffer(connectionId) {
        var peerReport = this.getPeerReport(connectionId);

        if (peerReport) {
            this.showMessage(peerReport.offerMessage);
        }
    }

    showAnswer(connectionId) {
        var peerReport = this.getPeerReport(connectionId);

        if (peerReport) {
            this.showMessage(peerReport.answerMessage);
        }
    }

    showMessage(msg) {
        const { div, span, p, pre } = van.tags;

        var width = window.innerWidth / 2;
        var height = window.innerHeight / 2;
        var x = width / 2;
        var y = height / 2;

        var data = JSON.parse(msg.text);

        van.add(document.body, FloatingWindow(
            {
                title: msg.type,
                x: x, y: y, width: width, height: height,
                childrenContainerStyleOverrides: { padding: 0 },
                headerColor: "white"
            },
            div({ style: `overflow:scroll; width:${width}px; height:${height - 20}px` }, pre(data.sdp))
        ));
    }

    async handleSignIn() {
        var error = document.getElementById('siError');
        var email = document.getElementById('siEmail').value;
        var pw = document.getElementById('siPassword').value;

        try {
            await firebase.auth().signInWithEmailAndPassword(email, pw);
        }
        catch (err) {
            error.innerText = err;
            error.style.display = 'block';
        }
    }

    async handleSignUp() {
        var error = document.getElementById('suError');
        var email = document.getElementById('suEmail').value;
        var pw = document.getElementById('suPassword').value;
        var repeat = document.getElementById('suRepeat').value;
        var displayName = document.getElementById('suDisplayName').value;

        if (pw != repeat) {
            error.innerText = 'Passwords do not match';
            error.style.display = 'block';
        }

        try {
            var credential = firebase.auth.EmailAuthProvider.credential(email, pw);
            var user = firebase.auth().currentUser;
            await user.linkWithCredential(credential);
            await user.updateProfile({ 'displayName': displayName });
        }
        catch (err) {
            error.innerText = err;
            error.style.display = 'block';
        }
    }
}