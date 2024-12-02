
// Where we are
// Offer and Answer exchange are working for two peers
// Now we need to tee up the next connection
// Add actual logic for peer selection
// We need to think about race conditions for answering offers.  What if two peers try to answer the same one?

class StreamTooth extends EventTarget {
    // Peers
    #peers = null;

    // Inbound STConnection
    #in = null;
    
    // Pending Outbound STConnection
    #out = null;

    // Established Outbound STConnections
    #outs = [];

    // Local stream
    #stream = null;

    // Video element for display
    #element = null;

    #statusTimer;
    #inputStartTimestamp;

    constructor(db, channel, element) {
        super();
        this.#peers = new STPeers(db, channel);
        this.#element = element;
    }

    get peerId() { return this.#peers.peerId; }

    setStream(stream) {
        console.log(`Updating stream to ${stream}`);
        this.#stream = stream;
        if (this.#element) 
            this.#element.srcObject = stream;
    }

    // Starts local stream from camera/microphone
    async startInputMedia() {
        var constraints = { audio:true, video:true };
        this.setStream(await navigator.mediaDevices.getUserMedia(constraints));

        this.#peers.addEventListener("offer", (ev) => { this.answerOffer(ev.detail); });
        this.#peers.listen();

        this.startStatusTimer();

        return this.#stream;
    }

    // Starts local stream from PeerConnection
    async startInputConnection() {
        this.#inputStartTimestamp = (new Date()).getTime();
        this.#in = new STConnection();

        this.#in.addEventListener("track", (ev) => { this.setStream(ev.detail.streams[0]); });
        this.#in.addEventListener("stateChange", (ev) => { this.updateConnectionState(this.#in); });
        this.#in.addEventListener("datachannel", (ev) => { this.addDataChannel(this.#in, ev.detail.dc); });

        await this.#in.setup();
        
        this.#peers.addEventListener("offer", (ev) => { this.answerOffer(ev.detail); });
        this.#peers.addEventListener("chat", (ev) => { this.dispatchChat(ev); });
        this.#peers.addEventListener("answer", (ev) => { this.collectAnswer(ev.detail); });
        this.#peers.listen();

        // Create offer for peer or whep proxy to answer.
        var offer = await this.#in.createOffer();
        this.#in.addEventListener("iceComplete", (ev) => { this.sendPeerDescription(ev, offer); });


        this.#in.startStats();
        this.startStatusTimer();

        return this.#in;
    }

    async restartInput() {
        if (this.#statusTimer) {
            window.clearInterval(this.#statusTimer);
            this.#statusTimer = null;
        }

        this.#inputStartTimestamp = (new Date()).getTime();
        // Reset the input connection
        await this.#in.disconnect();
        await this.#in.setup();
    
        // Create a new offer to connect.
        await this.#in.createOffer();

        this.#in.startStats();
        this.startStatusTimer();

        return this.#in;
    }

    async answerOffer(offer) {
        console.log(`Answering incoming offer from ${offer.from}`);

        if (offer.from == this.#peers.peerId) {
            console.log(`Offer is from me. Ignoring..`);
            return;
        }

        if (this.#in.connectionState != "connected") {
            console.log(`Cannot answer offer, My input is not connected.`);
            return;
        }

        this.#out = new STConnection();
        this.#out.addEventListener("stateChange", (ev) => { this.updateConnectionState(this.#out); });
        this.#out.addEventListener("datachannel", (ev) => { this.addDataChannel(this.#out, ev.detail.dc); });

        await this.#out.setup(this.#stream);
        var answer = await this.connectOffer(offer);

        this.#out.addEventListener("iceComplete", (ev) => { this.sendPeerDescription(ev, offer, answer); });



        this.#out.startStats('outbound-rtp');

        this.addOutput(this.#out);
    }

    addOutput(stc) {
        this.#outs.push(stc);
        console.log(`Added ${stc.connectionId} to outputs.  There are now ${this.#outs.length}`);
    }

    removeOutput(stc) {
        var idx = this.#outs.indexOf(stc);
        this.#outs.splice(idx, 1);
        console.log(`Removed ${stc.connectionId} from outputs.  There are now ${this.#outs.length}`);
     
        if (this.#outs.length == 0)
            this.#out = null;
        else 
            this.#out = this.#outs[this.#outs.length-1];
    }

    cleanOutputs() {
        for (var i=0; i<this.#outs.length; i++) {
            if (this.#outs[i].connectionState == "failed") {
                console.log(`Found lingering failed output.  Cleaning.`);
                this.#outs.splice(i, 1);
                i--;
            }
        }
    }

    #collectedAnswers = [];
    #answerCollectionTimer = null;

    collectAnswer(msg) {
        if (this.#in.connectionId != msg.replyTo) {
            console.log(`Cannot collect answer, it isn't in replyTo my offer.`);
            return;
        }
        if (this.#in.connectionState != "new" && this.#in.connectionState != "connecting") {
            console.log(`Cannot collect answer, input connection is ${this.#in.connectionState}`);
            return;
        }

        this.#collectedAnswers.push(msg);
        console.log(`Collected answer from ${msg.from}. ${this.#collectedAnswers.length} answers collected.`)

        if (this.#answerCollectionTimer) 
            window.clearTimeout(this.#answerCollectionTimer);

        this.#answerCollectionTimer = window.setTimeout(() => { this.chooseAnswer(); }, 1000);
    }

    chooseAnswer() {
        if (this.#collectedAnswers.length > 0) {
            var msgs = this.#collectedAnswers;
            msgs.forEach((msg) => { msg.answer = JSON.parse(msg.text); });
            msgs.sort((a, b) => a.answer.load - b.answer.load);
            this.connectAnswer(msgs[0]);
            this.#collectedAnswers = [];
        }
        else {
            console.log(`No answers available after timeout.`);
        }
    }

      /**
     * Establishes the connection to an offer we sent out earlier and was answered.
     * @param {*} answer 
     */
      async connectAnswer(msg) {
        var answer = msg.answer || JSON.parse(msg.text);
        this.#peers.addConnection(msg);
        await this.#in.connectRemote(answer);
    }

    async connectOffer(msg) {
        var offer = JSON.parse(msg.text);
        this.#peers.addConnection(msg);
        await this.#out.connectRemote(offer);
        var answer = await this.#out.createAnswer(this.#stream);

        answer['load'] = this.#outs.length;

        return answer;
    }

    async sendPeerDescription(ev, offer, answer) {
        // We receive a complete list of iceCandidates when creating an offer or answer
        // We need to vary the message depending on whether this event was triggered
        // by an inbound or outbound connection.
        var stc = ev.detail.stc;

        // STConnection has type of offer, answer, whep_offer, whep_answer..
        var msgType = stc.type;

        // If we are sending an answer, then include the offers from and id.
        if (answer) {
            var to = offer.from;
            var replyTo = offer.id;
        }

        console.log(`Sending peerDescription for ${msgType}`);

        // We need the description as it exists after ICE negotiation is completed.
        // We'll copy over the updated sdp from the event's description.
        var desc = answer || offer;
        desc.sdp = ev.detail.desc.sdp;
        
        var doc = this.#peers.send(msgType, desc, to, replyTo);
        stc.connectionId = replyTo || doc.id;
    }

    addDataChannel(stc, dc) {
        // If the data channel is to the origin then it's not useful.  Close an remove it.
        if (stc.remotePeerId == "origin") {
            console.log("Closing dataChannel because it's connected to the origin");
            dc.close();
        }
        else {
            this.#peers.addDataChannel(dc);
        }
    }

    async updateConnectionState(stc) {
        var newState = stc && stc.connectionState;
        console.log(`New connection state: ${newState}`);

        if (newState == "disconnected" || newState == "failed" || newState == "closed") {
            if (stc == this.#in) {
                console.log(`Input peer disconnected, re-establishing input connection`);
                await this.restartInput();
            }
            else {
                console.log(`Output peer disconnected, removing.`);
                this.removeOutput(stc);
            }
        }

        if (newState == "connected") {
            var peerId = this.#peers.getLastConnectionPeerId();
            stc.remotePeerId = peerId;
        
            this.dispatchEvent(new CustomEvent("peerConnected", { "detail": { "peerId": peerId }}));
        }
    }

    disconnect() {
        console.log(`Disconnecting all downstream viewers..`);
        if (this.#out) {
            for (var out of this.#outs) {
                out.disconnect();
            }
            this.#out = null;
            this.#outs = [];
        }
    }

    stop() {
        console.log(`Stopping all connections.`);
        this.disconnect();

        if (this.#in) {
            this.#in.disconnect();
            this.#in = null;
        }
        this.#peers.stop();

        if (this.#statusTimer) {
            window.clearInterval(this.#statusTimer);
            this.#statusTimer = null;
        }
    }

    startStatusTimer() {
        this.#statusTimer = window.setInterval(() => { this.statusCheck() }, 1000);
    }

    checkInputIsStale(report) {
        return (
            report.in && 
            report.in.state == "connected" &&
            report.in.lastReceivedTimestamp &&
            report.in.lastReceivedTimestamp < report.in.timestamp - 1000 &&
            this.#inputStartTimestamp < (new Date()).getTime() - 5000
        );
    }

    #checkInputTime = 3000;
    checkInputIsIgnored() {
        var result = (
            this.#in &&
            this.#in.connectionState == "new" &&
            this.#in.remoteDescription == null && 
            this.#inputStartTimestamp < (new Date()).getTime() - this.#checkInputTime
        )

        return result;
    }

    statusCheck() {
        var report = this.getPeersReport();

        if (this.checkInputIsStale(report)) {
            console.log(`Input connection has gone stale.  Resetting.`);
            this.restartInput();
        }

        if (this.checkInputIsIgnored()) {
            console.log(`Input connection was ignored for ${this.#checkInputTime}ms Resetting.`);
            this.#checkInputTime = this.#checkInputTime * 1.5;
            this.restartInput();
        }
        else if (this.#in.connectionState == "connected") {
            this.#checkInputTime = 3000;
        }

        this.cleanOutputs();

        this.dispatchEvent(new CustomEvent("status", { "detail": report }));
    }

    getPeersReport() {
        var report = {
            'peerId': this.peerId,
            'in': null,
            'outs': []
        };

        if (this.#in) {
            report.in = this.#in.getReport();
        }

        if (this.#outs.length > 0) {
            for (var out of this.#outs) {
                report.outs.push(out.getReport());
            }
        }

        return report;
    }

    sendMessage(text) {
        var msg = this.#peers.sendChat(text);

        this.dispatchChat({ "detail": msg });
    }

    dispatchChat(ev) {
        var message = ev.detail;
        this.dispatchEvent(new CustomEvent("chat", ev));
    }
}