
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
        this.#peers.addConnection(this.#in);
        
        this.#peers.addEventListener("offer", (ev) => { this.answerOffer(ev.detail); });
        this.#peers.addEventListener("chat", (ev) => { this.dispatchChat(ev); });
        this.#peers.addEventListener("answer", (ev) => { this.collectAnswer(ev.detail); });
        this.#peers.addEventListener("status", (ev) => { this.collectPeerStatus(ev.detail); })
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

    async answerOffer(offerMsg) {
        console.log(`Answering incoming offer from ${offerMsg.from}`);

        if (offerMsg.from == this.#peers.peerId) {
            console.log(`Offer is from me. Ignoring..`);
            return;
        }

        if (this.#in.connectionState != "connected") {
            console.log(`Cannot answer offer, My input is not connected.`);
            return;
        }

        var offerData = JSON.parse(offerMsg.text);
        // If we're doing a data only connection don't include a stream
        var stream = offerData.context == "data" ? null : this.#stream;
        
        var stc = new STConnection();
        stc.addEventListener("stateChange", (ev) => { this.updateConnectionState(stc); });
        stc.addEventListener("datachannel", (ev) => { this.addDataChannel(stc, ev.detail.dc); });

        // Setup the STConnection
        await stc.setup(stream);
        // Not needed, handled in connectRemote now.
        //stc.remotePeerId = offerMsg.from;

        // Add the connection to our peers
        this.#peers.addConnection(stc);

        // Set remote description and create an answer
        await stc.connectRemote(offerMsg);
        var answer = await stc.createAnswer();

        answer['load'] = this.#peers.load;

        // Set event listener for iceComplete with the answer included
        stc.addEventListener("iceComplete", (ev) => { this.sendPeerDescription(ev, offerMsg, answer); });

        // Start the stats collection if it's a media stream
        if (offerData.context != "data") {
            stc.startStats('outbound-rtp');
            this.#out = stc;            
        }

        // The answer will be sent when iceComplete event is triggered.
    }

    // TODO Refactor, how we handle multiple pending offers out to different peers
    #collectedAnswers = [];
    #answerCollectionTimer = null;

    collectAnswer(msg) {
        var stc = this.#peers.getConnectionByOfferId(msg.replyTo);

        if (stc == null) {
            console.log(`Cannot collect answer the replyTo doesn't match any connection`);
            return;
        }
        else if (stc.connectionState != "new" && stc.connectionState != "connecting") {
            console.log(`Cannot collect answer, connection state is ${stc.connectionState}`);
            return;
        }

        this.#collectedAnswers.push({'stc':stc, 'msg':msg});
        console.log(`Collected answer from ${msg.from}. ${this.#collectedAnswers.length} answers collected.`)

        if (this.#answerCollectionTimer) 
            window.clearTimeout(this.#answerCollectionTimer);

        this.#answerCollectionTimer = window.setTimeout(() => { this.chooseAnswer(); }, 1000);
    }

    async chooseAnswer() {
        if (this.#collectedAnswers.length > 0) {
            // Get the collected answers
            var answers = this.#collectedAnswers;

            // Parse the JSON of the answer to get the load information
            answers.forEach((answer) => { answer.msg.answer = JSON.parse(answer.msg.text); });

            // Sort by load (TODO group by offer for when we have multiple pending)
            answers.sort((a, b) => a.msg.answer.load - b.msg.answer.load);

            // Connect the first one
            await answers[0].stc.connectRemote(answers[0].msg);

            // Reset the collection
            this.#collectedAnswers = [];
        }
        else {
            console.log(`No answers available after timeout.`);
        }
    }

    async sendPeerDescription(ev, offer, answer, peerId) {
        // We receive a complete list of iceCandidates when creating an offer or answer
        // We need to vary the message depending on whether this event was triggered
        // by an inbound or outbound connection.
        var stc = ev.detail.stc;

        // STConnection has type of offer, answer, whep_offer, whep_answer..
        var msgType = stc.type;
        var to;
        var replyTo;

        // If we are sending an answer, then include the offers from and id.
        if (answer) {
            to = offer.from;
            replyTo = offer.id;
        }
        // If we are sending a data-only offer to a specific peer include the to
        else if (peerId) {
            to = peerId;
        }

        console.log(`Sending peerDescription for ${msgType}`);

        // We need the description as it exists after ICE negotiation is completed.
        // We'll copy over the updated sdp from the event's description.
        var desc = answer || offer;
        desc.sdp = ev.detail.desc.sdp;
        
        var doc = this.#peers.send(msgType, desc, to, replyTo);
        //stc.connectionId = replyTo || doc.id;
        stc.setMessage(msgType, doc);
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
                this.#peers.removeConnection(stc);
            }
        }

        if (newState == "connected") {
            if (!stc.remotePeerId) {
                var peerId = this.#peers.getLastConnectionPeerId();
                stc.remotePeerId = peerId;
            }
            else {
                console.log("I don't need remotePeerId set in connected status");
            }
        
            this.dispatchEvent(new CustomEvent("peerConnected", { "detail": { "peerId": peerId }}));
        }
    }

    disconnect() {
        console.log(`Disconnecting all downstream viewers..`);
        this.#peers.disconnect('video', 'answer');
    }

    stop() {
        console.log(`Stopping all connections.`);
        this.#peers.stop();

        if (this.#statusTimer) {
            window.clearInterval(this.#statusTimer);
            this.#statusTimer = null;
        }
    }

    startStatusTimer() {
        this.#statusTimer = window.setInterval(() => { this.statusCheck() }, 1000);
    }

    /**
     * @returns True if an input reports its last packet received was 
     * over a second ago and the connection has been up for 5 seconds
     */
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

    /**
     * @returns True if an offer has gone unanswered for 3 seconds
     */
    checkInputIsIgnored() {
        var result = (
            this.#in &&
            this.#in.connectionState == "new" &&
            this.#in.remoteDescription == null && 
            this.#inputStartTimestamp < (new Date()).getTime() - this.#checkInputTime
        )

        return result;
    }

    #lastStatusMessageTime = (new Date()).getTime();

    /**
     * Sends a status report message to the peer network
     */
    dispatchStatusMessage(report) {
        var now = (new Date()).getTime();
        if (now - this.#lastStatusMessageTime > 30000) {
            this.#lastStatusMessageTime = now;
            this.#peers.sendStatus(report);
        }
    }

    /**
     * Resets the input connection if the stats say it hasn't updated in awhile
     */
    fixStaleInputs(report) {
        if (this.checkInputIsStale(report)) {
            console.log(`Input connection has gone stale.  Resetting.`);
            this.restartInput();
        }
    }

    /**
     * Resets the input connection when an offer goes unanswered for too long
     */
    fixIgnoredInput() {
        if (this.checkInputIsIgnored()) {
            console.log(`Input connection was ignored for ${this.#checkInputTime}ms Resetting.`);
            this.#checkInputTime = this.#checkInputTime * 1.5;
            this.restartInput();
        }
        else if (this.#in.connectionState == "connected") {
            this.#checkInputTime = 3000;
        }
    }

    /**
     * Gather a report of input and output connections and stats associated with them 
     * @returns report
     */
    getPeersReport() {
        var report = {
            'peerId': this.peerId,
            'peers': []
        };

        this.#peers.forEach((stc) => { report.peers.push(stc.getReport())});

        return report;
    }

    statusCheck() {
        var report = this.getPeersReport();

        // If the input stream hasn't changed in awhile, reset it
        this.fixStaleInputs(report);

        // If the offer we sent hasn't been answered in awhile, try again
        this.fixIgnoredInput();

        // Clean connnections that are failed but didn't clean up after themselves.
        this.#peers.cleanConnections();

        // Send the status event to anyone listening.
        this.dispatchEvent(new CustomEvent("status", { "detail": report }));

        // Send a status message periodically
        this.dispatchStatusMessage(report);
    }

    sendMessage(text) {
        var msg = this.#peers.sendChat(text);

        this.dispatchChat({ "detail": msg });
    }

    dispatchChat(ev) {
        var message = ev.detail;
        this.dispatchEvent(new CustomEvent("chat", ev));
    }

    getUniquePeers(report) {
        var uniqueIds = {};
        uniqueIds[report.peerId] = 1;

        for (var peer of report.peers) {
            if (peer.remotePeerId)
                uniqueIds[peer.remotePeerId] = 1;
        }

        return Object.keys(uniqueIds);
    }

     // Starts local stream from PeerConnection
     async startPeerDataConnection(peerId) {
        console.log(`Starting data-only connection to ${peerId}`);
        var stc = new STConnection();

        stc.addEventListener("stateChange", (ev) => { this.updateConnectionState(stc); });
        stc.addEventListener("datachannel", (ev) => { this.addDataChannel(stc, ev.detail.dc); });

        await stc.setup();
        // I don't need this, it's done in connectRemote
        //stc.remotePeerId = peerId;
        
        var offer = await stc.createOffer("data");
        stc.addEventListener("iceComplete", (ev) => { this.sendPeerDescription(ev, offer, null, peerId); });

        this.#peers.addConnection(stc);

        return stc;
    }

    connectNewPeers(report) {
        var peers = this.getUniquePeers(report);
        for (var peer of peers) {
            if (peer == this.peerId)
                continue;

            if (!this.#peers.isConnectedTo(peer)) {
                this.startPeerDataConnection(peer);
            }
        }
    }

    collectPeerStatus(msg) {
        console.log(`Got status from ${msg.from}`)
        var report = JSON.parse(msg.text);

        this.connectNewPeers(report);
    }
}