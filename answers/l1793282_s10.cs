using System;

class Program
{
    static void Main()
    {
        int chislo = int.Parse(Console.ReadLine());

        for (int i = 1; i <= chislo; i++)
        {
            Console.WriteLine(i + " " + (i * i) + " " + (i * i * i));
        }
    }
}