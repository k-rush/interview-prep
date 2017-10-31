public class Node {
	Node next = null;
	int data;

	public Node(int d) {
		data = d;
	}

	public void appendToTail(int d) {
		Node end = new Node(d);
		Node n = this;

		while(n.next != null) {
			n = n.next;
		}

		n.next = end;
	}

	public String toString() {
		return Integer.toString(data,10);
	}
}